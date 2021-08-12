/**
 * TODO:
 *  - Implement Double and other SIMD types
 *  - Add check for correct number / type of arguments.
 * 	- Can we tell whether a function throws via its metadata?
 */

import { Protocol, Type, ValueType } from "./types";
import { ObjectInstance,
         RuntimeInstance,
         makeValueInstance} from "./runtime";
import { TargetValueMetadata } from "../abi/metadata";
import { TargetOpaqueExistentialContainer } from "../runtime/existentialcontainer";
import { Registry } from "./registry";

export type SwiftType = Type | Protocol;

class TrampolinePool {
    private static pages: NativePointer[];
    private static currentSlot: NativePointer;

    private static get currentPage(): NativePointer {
        return TrampolinePool.pages[TrampolinePool.pages.length - 1];
    }

    private static _initialize() {
        TrampolinePool.pages = [Memory.alloc(Process.pageSize)];
        TrampolinePool.currentSlot = TrampolinePool.currentPage;
    }

    public static allocateTrampoline(size: number): NativePointer {
        if (TrampolinePool.pages === undefined) {
            TrampolinePool._initialize();
        }

        let currentPage = TrampolinePool.currentPage;
        const currentPageEnd = currentPage.add(Process.pageSize);

        if (TrampolinePool.currentSlot.add(size).compare(currentPageEnd) > 0) {
            currentPage = Memory.alloc(Process.pageSize);
            TrampolinePool.pages.push(currentPage);
        }

        const currentSlot = TrampolinePool.currentSlot;
        TrampolinePool.currentSlot = TrampolinePool.currentSlot.add(size);

        return currentSlot;
    }
}

type NativeStorageUnit = UInt64 | NativePointer;

function makeBufferFromValue(fields: NativeStorageUnit[]): NativePointer {
    const size = Process.pointerSize * fields.length;
    const buffer = Memory.alloc(size);

    for (let i = 0, offset = 0; offset < size; i++, offset += Process.pointerSize) {
        const field = fields[i];
        const target = buffer.add(offset);

        if (field instanceof NativePointer) {
            target.writePointer(field);
        } else if (field instanceof UInt64) {
            target.writeU64(field);
        } else {
            throw new Error("Bad field type");
        }
    }

    return buffer;
}

function moveValueToBuffer(fields: UInt64[], buffer: NativePointer) {
    const size =  Process.pointerSize * fields.length;

    for (let i = 0, offset = 0; offset < size; i++, offset += Process.pointerSize) {
        buffer.add(offset).writeU64(fields[i]);
    }
}

function makeValueFromBuffer(buffer: NativePointer, lengthInBytes: number): UInt64[] {
    const result: UInt64[] = [];

    /* XXX: Assume only buffer sizes that are multiples of 8 for now  */
    for (let i = 0; i < lengthInBytes; i += 8) {
        result.push(buffer.add(i).readU64());
    }

    return result;
}

export function makeSwiftNativeFunction(address: NativePointer,
                                        retType: SwiftType,
                                        argTypes: SwiftType[],
                                        context?: NativePointer,
                                        throws?: boolean): Function {
    const loweredArgType = argTypes.map(ty => lowerSemantically(ty));
    const loweredRetType = lowerSemantically(retType);

    const swiftcallWrapper = new SwiftcallNativeFunction(address, loweredRetType,
                loweredArgType, context).wrapper;

    const wrapper = function(...args: RuntimeInstance[]) {
        const actualArgs: any[] = [];

        for (const [i, arg] of args.entries()) {

            if (argTypes[i] instanceof Protocol) {
                const typeMetadata = arg.typeMetadata;
                const typeName = typeMetadata.getDescription().name;
                const type = Registry.shared().typeByName(typeName);
                const container = TargetOpaqueExistentialContainer.alloc();
                const proto = argTypes[i] as Protocol;

                container.type = typeMetadata;
                container.setWitnessTable(
                            type.conformances[proto.name].witnessTable);

                if (typeMetadata.isClassObject()) {
                    container.buffer.privateData.writePointer(arg.handle);
                } else {
                    const box = typeMetadata.allocateBoxForExistentialIn(
                            container.buffer);
                    (<ValueType>type).copyRaw(box, arg.handle);
                }

                actualArgs.push(lowerPhysically(container));
            } else {
                actualArgs.push(lowerPhysically(arg));
            }
        }

        const retval = swiftcallWrapper(...actualArgs);

        if (retType instanceof Protocol) {
            const buf = makeBufferFromValue(retval);
            const container = TargetOpaqueExistentialContainer.makeFromRaw(buf);
            const typeMetadata = container.type;
            const runtimeTypeName = typeMetadata.getDescription().name;
            const runtimeType = Registry.shared().typeByName(runtimeTypeName);

            if (typeMetadata.isClassObject()) {
                return new ObjectInstance(
                        container.buffer.privateData.readPointer());
            } else {

                const valueType = runtimeType as ValueType;
                const handle = container.projectValue();
                return valueType.intializeWithCopyRaw(handle);
            }
        }

        switch (retType.kind) {
            case "Struct":
            case "Enum":
                const buffer = makeBufferFromValue(retval);
                return makeValueInstance(retType as ValueType, buffer);
            case "Class":
                return new ObjectInstance(retval as NativePointer);
            default:
                throw new Error("Unimplemented kind: " + retType.kind);
        }
    }

    return wrapper;
}

function lowerSemantically(type: SwiftType): NativeType {
    if (type instanceof Protocol) {
        return ["uint64", "uint64", "uint64", "pointer", "pointer"];
    }

    /* FIXME: ugly */
    if (type.kind === "Class" || shouldPassIndirectly((<ValueType>type).metadata)) {
        return "pointer";
    }

    const valueType = type as ValueType;
    /**TODO:
     * - Make it arch-agnostic
     * - Unsigned ints?
     */
    let sizeInQWords = valueType.typeLayout.stride / 8;
    sizeInQWords = sizeInQWords > 1 ? sizeInQWords : 1;
    return Array(sizeInQWords).fill("uint64");
}

function lowerPhysically(value: RuntimeInstance| TargetOpaqueExistentialContainer):
            UInt64 | UInt64[] | NativePointer {
    if (value instanceof ObjectInstance) {
        return value.handle;
    } else if (value instanceof TargetOpaqueExistentialContainer) {
        return makeValueFromBuffer(value.handle,
                   TargetOpaqueExistentialContainer.SIZEOF);
    }

    if (shouldPassIndirectly(value.typeMetadata as TargetValueMetadata)) {
        return value.handle;
    }

    return makeValueFromBuffer(value.handle,
                value.typeMetadata.getTypeLayout().stride);
}

function shouldPassIndirectly(typeMetadata: TargetValueMetadata) {
    const vwt = typeMetadata.getValueWitnesses();
    return !vwt.flags.isBitwiseTakable;
}

class StrongQueue<T> {
    #queue: Record<number, T> = {};
    #next = 0;

    get length(): number {
        return Object.keys(this.#queue).length - this.#next;
    }

    enqueue(item: T) {
        const tail = Object.keys(this.#queue).length;
        this.#queue[tail] = item;
    }

    dequeue(): T {
        if (Object.keys(this.#queue).length === 0) {
            return undefined;
        }

        const item = this.#queue[this.#next];
        delete this.#queue[this.#next++];

        return item;
    }

    toJSON() {
        return this.#queue;
    }
}

export class SwiftcallNativeFunction {
    #argumentBuffers: StrongQueue<NativePointer>;
    #resultType: NativeType;
    #returnBufferSize?: number;
    #returnBuffer?: NativePointer;
    #extraBuffer: NativePointer;
    #nativeFunction: NativeFunction;

    constructor(target: NativePointer, resultType: NativeType,
                argTypes: NativeType[], context?: NativePointer,
                errorResult?: NativePointer) {
        this.#argumentBuffers = new StrongQueue<NativePointer>();

        argTypes = argTypes.map(argType => {
            if (Array.isArray(argType) && argType.length > 4) {
                const buf = Memory.alloc(Process.pointerSize * argType.length);
                this.#argumentBuffers.enqueue(buf);

                return "pointer";
            }
            return argType;
        }).flat();

        this.#resultType = resultType;
        let indirectResult: NativePointer;

        if (Array.isArray(resultType)) {
            this.#returnBufferSize = Process.pointerSize * resultType.length;
            this.#returnBuffer = Memory.alloc(this.#returnBufferSize);

            if (resultType.length > 4) {
                indirectResult = this.#returnBuffer;
            }
        } else {
            this.#returnBufferSize = Process.pointerSize;
            this.#returnBuffer = Memory.alloc(this.#returnBufferSize);
        }

        this.#extraBuffer= Memory.alloc(Process.pointerSize * 2);

        const maxPatchSize = 0x4C;
        const trampoline = TrampolinePool.allocateTrampoline(maxPatchSize);

        Memory.patchCode(trampoline, maxPatchSize, (code) => {
            const writer = new Arm64Writer(code, { pc: trampoline });

            /* TODO: not thread safe? */
            writer.putLdrRegAddress("x15", this.#extraBuffer);
            writer.putStpRegRegRegOffset("x29", "x30", "x15", 0, "post-adjust");

            if (context !== undefined) {
                writer.putLdrRegAddress("x20", context);
            }

            /* TODO: test this */
            if (errorResult !== undefined) {
                writer.putLdrRegAddress("x21", errorResult);
            }

            if (indirectResult !== undefined) {
                writer.putLdrRegAddress("x8", indirectResult);
            }

            writer.putLdrRegAddress("x14", target)
            writer.putBlrRegNoAuth("x14");

            if (indirectResult === undefined && this.#returnBufferSize > 0) {
                writer.putLdrRegAddress("x15", this.#returnBuffer);

                let i = 0, offset = 0;

                for (; offset < this.#returnBufferSize; i++, offset += 8) {
                    const reg = `x${i}` as Arm64Register;
                    writer.putStrRegRegOffset(reg, "x15", offset);
                }
            }

            writer.putLdrRegAddress("x15", this.#extraBuffer);
            writer.putLdpRegRegRegOffset("x29", "x30", "x15", 0, "post-adjust");
            writer.putRet();

            writer.flush();
        });;

        this.#nativeFunction = new NativeFunction(trampoline, "pointer", argTypes)
    }

    wrapper = (...args: NativeArgumentValue[]) => {
        /* TODO: Type-check args? */

        args = args.map(arg => {
            if (Array.isArray(arg) && arg.length > 4) {
                const argBuf = this.#argumentBuffers.dequeue();
                moveValueToBuffer(arg, argBuf);

                return argBuf;
            }
            return arg;
        }).flat();

        const func = this.#nativeFunction;
        func(...args);

        if (this.#returnBufferSize === 0) {
            return undefined;
        }

        const result: NativeReturnValue[] = [];

        if (!Array.isArray(this.#resultType)) {
            return this.#returnBuffer.readValue(this.#resultType);
        }

        /* TODO: handle signed values */
        for (let i = 0, j = 0; i < this.#returnBufferSize; i += 8, j++) {
            const type = this.#resultType[j];
            result.push(this.#returnBuffer.add(i).readValue(type));
        }

        return result;
    }

    call(...args: NativeArgumentValue[]): NativeReturnValue[] {
        return this.wrapper(args);
    }
}

declare global {
    interface NativePointer {
        readValue(type: NativeType);
    }
}

NativePointer.prototype.readValue = function(type: NativeType): NativeReturnValue {
    switch (type) {
        case "pointer":
            return this.readPointer();
        case "string":
            return this.readCString();
        case "int":
            return this.readInt();
        case "uint":
            return this.readUInt();
        case "long":
            return this.readLong();
        case "ulong":
            return this.readULong();
        case "int8":
            return this.readS8();
        case "uint8":
            return this.readU8();
        case "int16":
            return this.readS16();
        case "uint16":
            return this.readU16();
        case "int32":
            return this.readS32();
        case "uint32":
            return this.readU32();
        case "int64":
            return this.readS64();
        case "uint64":
            return this.readU64();
        default:
            throw new Error(`Unimplemented type: ${type}`);
    }
}
