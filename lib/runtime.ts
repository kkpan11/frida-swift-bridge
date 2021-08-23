/**
 * TODO:
 *  - Pretty print enum values
 */

import { TargetClassMetadata,
         TargetEnumMetadata,
         TargetMetadata,
         TargetStructMetadata,
         TargetValueMetadata } from "../abi/metadata";
import { HeapObject } from "../runtime/heapobject";
import { makeBufferFromValue, RawFields } from "./buffer";
import { Registry } from "./registry";
import { Enum, Struct, ValueType } from "./types";

/* XXX: If you think this is bad, please suggest a better name */
export abstract class RuntimeInstance {
    readonly typeMetadata: TargetMetadata;
    readonly handle: NativePointer;

    equals(other: RuntimeInstance) {
        return this.handle.equals(other.handle);
    }

    toJSON() {
        return {
            handle: this.handle
        }
    }
}

export abstract class ValueInstance extends RuntimeInstance {
    readonly typeMetadata: TargetValueMetadata;
}

export class StructValue implements ValueInstance {
    readonly typeMetadata: TargetStructMetadata;
    readonly handle: NativePointer;

    constructor(readonly type: Struct, storage: RawFields | NativePointer) {
        this.typeMetadata = type.metadata;
        this.handle = (storage instanceof NativePointer) ?
                      storage :
                      makeBufferFromValue(storage);
    }

     equals(other: StructValue) {
        return this.handle.equals(other.handle);
    }

    toJSON() {
        return {
            handle: this.handle,
        };
    }
}

export class EnumValue implements ValueInstance {
    readonly typeMetadata: TargetEnumMetadata;
    readonly handle: NativePointer;

    #tag: number;
    #payload: RuntimeInstance;

    constructor(readonly type: Enum, storage: RawFields | NativePointer) {
        this.typeMetadata = type.metadata;
        this.handle = (storage instanceof NativePointer) ?
                      storage :
                      makeBufferFromValue(storage);

        const tag = this.type.metadata.vw_getEnumTag(this.handle);
        let payload: RuntimeInstance;

        if (tag - this.type.payloadCases.length >= this.type.emptyCases.length) {
            throw new Error("Invalid pointer for an enum of this type");
        }

        if (this.isPayloadTag(tag)) {
            const typeName = this.type.payloadCases[tag].typeName;
            const type = Registry.shared().typeByName(typeName);
            payload = (type instanceof ValueType) ?
                      type.makeValueFromRaw(this.handle) :
                      new ObjectInstance(this.handle);
        }

        this.#tag = tag;
        this.#payload = payload;
    }

    setContent(tag: number, payload?: RuntimeInstance) {
        if (tag - this.type.payloadCases.length >= this.type.emptyCases.length) {
            throw new Error("Invalid tag for an enum of this type");
        }

        if (this.isPayloadTag(tag)) {
            const typeName = this.type.payloadCases[tag].typeName;
            const type = Registry.shared().typeByName(typeName);

            if (payload.typeMetadata.getDescription().name !== type.$name) {
                throw new Error("Payload must be of type " + typeName);
            }

            if (payload instanceof ObjectInstance) {
                this.handle.writePointer(payload.handle);
                this.#payload = payload;
            } else {
                const valueType = type as ValueType;
                this.#payload = valueType.makeValueFromRaw(this.handle);
                valueType.copy(<ValueInstance>this.#payload,
                            <ValueInstance>payload);
            }
        }

        this.type.metadata.vw_destructiveInjectEnumTag(this.handle, tag);
        this.#tag = tag;
    }

    get tag(): number {
        return this.#tag;
    }

    get payload(): RuntimeInstance {
        return this.#payload;
    }

    equals(e: EnumValue) {
        let result = false;

        if (this.tag !== undefined && e.tag !== undefined) {
            result = this.tag === e.tag;
        }

        if (this.payload !== undefined && e.payload !== undefined) {
            /* TODO: handle value type equality properly */
            result &&= this.payload.handle.equals(e.payload.handle);
        }

        return result;
    }

    toJSON() {
        return {
            handle: this.handle,
            tag: this.#tag,
            payload: this.#payload,
        }
    }

    private isPayloadTag(tag: number) {
        return tag < this.type.payloadCases.length;
    }
}

export class ObjectInstance extends RuntimeInstance {
    readonly typeMetadata: TargetClassMetadata;

    #heapObject: HeapObject;

    constructor(readonly handle: NativePointer) {
        super();
        this.#heapObject = new HeapObject(handle);
        this.typeMetadata = this.#heapObject.getMetadata(TargetClassMetadata);
    }
}
