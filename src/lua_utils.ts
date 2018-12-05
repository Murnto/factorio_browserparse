import * as assert from "assert";
// @ts-ignore
import { lua, to_jsstring } from "fengari";

export function push_js_object(L: any, obj: any | number) {
    if (Array.isArray(obj)) {
        lua.lua_createtable(L, obj.length, 0);

        for (let i = 0; i < obj.length; i++) {
            push_js_object(L, obj[i]);
            lua.lua_rawseti(L, -2, i + 1);
        }

        // console.log('pusharray', obj);
    } else if (obj === undefined || obj === null) {
        lua.lua_pushnil(L);
        // console.log('pushnil', obj);
    } else if (typeof obj === "object") {
        const keys = Object.keys(obj);

        lua.lua_createtable(L, 0, keys.length);

        for (const k of keys) {
            lua.lua_pushstring(L, k);
            push_js_object(L, obj[k]);
            lua.lua_rawset(L, -3);
        }

        // console.log('pushtable', obj);
    } else if (typeof obj === "string") {
        lua.lua_pushstring(L, obj);
        // console.log('pushstring', obj);
    } else if (typeof obj === "number") {
        lua.lua_pushnumber(L, obj);
        // console.log('pushnumber', obj);
    } else {
        throw new Error(`Unknown object type: ${typeof obj}: "${obj}"`);
    }
}

export function stack_dump(L: any, key?: string) {
    const stack = [];
    const top = lua.lua_gettop(L);
    for (let i = 1; i <= top; i++) {
        const type = lua.lua_type(L, i);
        switch (type) {
            case lua.LUA_TSTRING:
                stack.push(lua.lua_tojsstring(L, i));
                break;
            case lua.LUA_TBOOLEAN:
                stack.push(lua.lua_toboolean(L, i) ? "true" : "false");
                break;
            case lua.LUA_TNUMBER:
                stack.push(lua.lua_tonumber(L, i));
                break;
            default:
                stack.push(to_jsstring(lua.lua_typename(L, type)));
                break;
        }
    }

    console.log(`${key ? key : "Stack"}: [${stack.join(" -> ")}]`);
}

export function table_to_object(L: any, index: number) {
    const initialTop = lua.lua_gettop(L);

    lua.lua_pushinteger(L, 1);

    assert(lua.lua_gettop(L) === initialTop + 1);
    lua.lua_pop(L, 1);
    assert(lua.lua_gettop(L) === initialTop);

    const obj = {};
    let allNumbers = true;

    lua.lua_pushnil(L); // first key
    assert(lua.lua_gettop(L) === initialTop + 1);

    while (lua.lua_next(L, index - 1)) {
        assert(lua.lua_gettop(L) === initialTop + 2);
        const top = lua.lua_gettop(L);

        if (!lua.lua_isstring(L, -2)) {
            throw new Error("Key wasn't a string?");
        }

        const value = lua_value_to_js(L, -1);

        if (allNumbers && !lua.lua_isnumber(L, -2)) {
            allNumbers = false;
        }

        let key;
        if (lua.lua_isnumber(L, -2)) {
            key = lua.lua_tonumber(L, -2);
        } else {
            key = lua.lua_tojsstring(L, -2);
        }
        obj[key] = value;

        if (lua.lua_gettop(L) !== top) {
            console.log("Top changed! From", top, "to", lua.lua_gettop(L));
        }

        lua.lua_pop(L, 1); // pop the value so the key is on top
    }

    assert(lua.lua_gettop(L) === initialTop, `current=${lua.lua_gettop(L)} orig=${initialTop}`);

    if (allNumbers && Object.keys(obj).length !== 0) {
        const asArray: any[] = [];

        for (const key of Object.keys(obj)) {
            asArray[(key as any) - 1] = obj[key];
        }

        return asArray;
    }

    return obj;
}

export function table_get_keys(L: any, index: number) {
    const obj = [];

    lua.lua_pushnil(L); // first key
    while (lua.lua_next(L, index - 1)) {
        if (lua.lua_isstring(L, -2)) {
            if (lua.lua_isnumber(L, -2)) {
                obj.push(lua.lua_tonumber(L, -2));
            } else {
                obj.push(lua.lua_tojsstring(L, -2));
            }
        } else if (lua.lua_islightuserdata(L, -2)) {
            obj.push("@" + lua.lua_tojsstring(L, -2));
        } else {
            throw new Error("Key wasn't a string?");
        }

        lua.lua_pop(L, 1); // pop the value so the key is on top
    }

    return obj;
}

export function lua_value_to_js(L: any, index: number): any {
    const type = lua.lua_type(L, index);
    switch (type) {
        case lua.LUA_TNONE:
            throw new Error(`Unhandled type: "LUA_TNONE"`);
        case lua.LUA_TNIL:
            return null;
        case lua.LUA_TBOOLEAN:
            return !!lua.lua_toboolean(L, index);
        case lua.LUA_TLIGHTUSERDATA:
            throw new Error(`Unhandled type: "LUA_TLIGHTUSERDATA"`);
        case lua.LUA_TNUMBER:
            return lua.lua_tonumber(L, index);
        case lua.LUA_TSTRING:
            return lua.lua_tojsstring(L, index);
        case lua.LUA_TTABLE:
            return table_to_object(L, index);
        case lua.LUA_TFUNCTION:
            return "[[[Function]]]";
            throw new Error(`Unhandled type: "LUA_TFUNCTION"`);
        case lua.LUA_TUSERDATA:
            throw new Error(`Unhandled type: "LUA_TUSERDATA"`);
        case lua.LUA_TTHREAD:
            throw new Error(`Unhandled type: "LUA_TTHREAD"`);
        default:
            throw new Error(`Unhandled and unknown type: "${type}"`);
    }
}

export function lua_stack_trace_introspect(L: any) {
    let stack = L.ci;
    let i = 0;

    while (stack) {
        const func = stack.func;

        if (func !== undefined) {
            switch (func.type) {
                case 6:
                    const { id, p } = func.value;

                    const pc = stack.l_savedpc;
                    const lineNo = p.lineinfo[pc - 1];
                    const source = new TextDecoder("utf-8").decode(p.source.realstring);
                    const k = [];
                    for (const v of p.k) {
                        if (v && v.value) {
                            k.push(new TextDecoder("utf-8").decode(v.value.realstring));
                        }
                    }

                    console.log(`level ${i}: line=${lineNo} id=${id} p.plen=${p.p.length} source=${source} k=${k}`);
                    break;
                default:
                    console.log(`level ${i}: unk func type ${func.type}`);
                    break;
            }
        }

        stack = stack.next;
        i++;
    }
}

export function lua_stack_trace(L: any) {
    const stack: any = {};

    let i = 0;
    while (lua.lua_getstack(L, i++, stack) !== 0) {
        const func = stack.i_ci.func;
        switch (func.type) {
            case 6:
                const { id, p } = func.value;

                const pc = stack.i_ci.l_savedpc;
                const lineNo = p.lineinfo[pc - 1];
                const source = new TextDecoder("utf-8").decode(p.source.realstring);
                const k = [];
                for (const v of p.k) {
                    if (v && v.value) {
                        k.push(new TextDecoder("utf-8").decode(v.value.realstring));
                    }
                }

                console.log(`level ${i}: line=${lineNo} id=${id} p.plen=${p.p.length} source=${source} k=${k}`);
                break;
            default:
                console.log(`level ${i}: unk func type ${func.type}`);
                break;
        }
    }
}

export function mostRecentFileInStackTrace(L: any): string | undefined {
    const stack: any = {};
    let i = 0;

    while (lua.lua_getstack(L, i++, stack) !== 0) {
        const func = stack.i_ci.func;
        if (!func || func.type !== 6) {
            continue;
        }

        const { p } = func.value;
        // const lineNo = p.lineinfo[stack.i_ci.l_savedpc - 1];
        const source = new TextDecoder("utf-8").decode(p.source.realstring);

        if (source.startsWith("@")) {
            // console.log(`level ${i}: line=${lineNo} id=${id} p.plen=${p.p.length} source=${source}`);

            return source;
        }
    }

    return undefined;
}
