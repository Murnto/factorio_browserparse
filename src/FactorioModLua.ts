import { FactorioPack } from "./FactorioPack";
import { lua_stack_trace_introspect, mostRecentFileInStackTrace, push_js_object } from "./lua_utils";
import { FactorioMod } from "./FactorioMod";
import apiDefines from "./ApiDefines";
// @ts-ignore
import * as fengari from "fengari";
// @ts-ignore
import { luaS_newliteral } from "fengari/src/lstring";
// @ts-ignore
import { luaH_getstr, luaH_new } from "fengari/src/ltable";

const {
    to_luastring,
    lua,
    lauxlib: { luaL_newstate, luaL_loadstring, luaL_loadbuffer },
    lualib: { luaL_openlibs },
} = fengari;

type DefinesDef = string[] | { [index: string]: DefinesDef };

export class FactorioModLua {
    public L: any;
    private availableContexts: FactorioMod[] = [];
    private coreContext!: FactorioMod;
    private storedContextState: { [index: string]: any } = {};
    private internalLoaded: any;

    public init() {
        const L = (this.L = luaL_newstate());
        lua.lua_checkstack(this.L, 100);
        luaL_openlibs(L);
        // Report native errors
        lua.lua_atnativeerror(L, (l: any) => {
            console.error(lua.lua_touserdata(l, 1));
            return 1;
        });

        this.init_defines(apiDefines);

        // language=Lua
        this.exec_lua(`
            function log(x)
            end

            function table_size(T)
                local count = 0
                for _ in pairs(T) do
                    count = count + 1
                end
                return count
            end
        `);

        this.hook_require();

        this.internalLoaded = luaH_getstr(L.l_G.l_registry.value, luaS_newliteral(L, "_LOADED"));
    }

    public load_mods(p: FactorioPack, mods: FactorioMod[]) {
        const L = this.L;

        const modsList = {};
        for (const mod of mods) {
            modsList[mod.info.name] = mod.info.version;
        }
        push_js_object(L, modsList);
        lua.lua_setglobal(L, "mods");

        this.coreContext = mods.splice(0, 1)[0];
        this.coreContext.luaPaths.push("lualib/");
        this.setModContext(this.coreContext);

        // language=Lua
        this.exec_lua(`
            require('dataloader')
            require('data')
        `);

        this.loadSettings(p, mods);
        this.loadData(p, mods);
    }

    public exec_lua(code: string) {
        luaL_loadstring(this.L, to_luastring(code));
        // lua.lua_resume(this.L, null, 0)
        const result = lua.lua_pcall(this.L, 0, lua.LUA_MULTRET, 0);
        if (result) {
            lua_stack_trace_introspect(this.L);
            throw new Error(`Failed to run script:  ${lua.lua_tojsstring(this.L, -1)}`);
        }
    }

    public close() {
        this.storedContextState = {};
        this.internalLoaded = null;
        lua.lua_close(this.L);
        console.log("bye");
    }

    private lua_require(L: any) {
        const path = lua.lua_tojsstring(L, -1);
        // console.log(`require("${path}")`);

        lua.lua_pop(L, 1);

        const additionalSearchPath = [];
        const requiringFile = mostRecentFileInStackTrace(L);

        if (requiringFile) {
            additionalSearchPath.push({
                modName: requiringFile.slice(1, requiringFile.indexOf("/")),
                path: requiringFile.slice(requiringFile.indexOf("/") + 1, requiringFile.lastIndexOf("/") + 1),
            });
        }

        const result = this.find_script_in_context(path, true, additionalSearchPath);

        if (result === null) {
            return 0;
        }

        const content = result.content;
        const fpath = result.mod.info.name + "/" + path.replace(/\./g, "/") + ".lua";

        if (content === null) {
            return 0;
        }

        const pkgData = to_luastring(content);

        luaL_loadbuffer(L, pkgData, pkgData.length, to_luastring("@" + fpath));
        lua.lua_pushfstring(L, to_luastring("@%s"), to_luastring(fpath));

        return 2; /* return open function and file name */
    }

    private init_defines(data: DefinesDef, key?: string) {
        const L = this.L;

        if (key === undefined) {
            lua.lua_newtable(L);
            lua.lua_pushvalue(L, -1);
            lua.lua_setglobal(L, "defines");
        }

        if (Array.isArray(data)) {
            for (let i = 0; i < data.length; i++) {
                lua.lua_pushstring(L, data[i]);
                lua.lua_pushinteger(L, i + 1);

                lua.lua_rawset(L, -3);
            }
        } else {
            for (const k of Object.keys(data)) {
                lua.lua_newtable(L);
                lua.lua_pushstring(L, k);
                lua.lua_pushvalue(L, -2); // duplicate the new table
                lua.lua_rawset(L, -4);

                this.init_defines(data[k], k);
            }
        }

        lua.lua_pop(L, 1);
    }

    private hook_require() {
        const L = this.L;

        // language=Lua
        this.exec_lua(`
            package.searchers[3] = nil
            package.searchers[4] = nil
        `);

        // TODO improve table access
        lua.lua_getglobal(L, "package");
        lua.lua_pushstring(L, "searchers");
        lua.lua_gettable(L, -2);
        lua.lua_pushnumber(L, 2);
        lua.lua_pushcfunction(L, this.lua_require.bind(this));
        lua.lua_settable(L, -3);

        lua.lua_pop(L, 2);
    }

    private find_script_in_context(
        path: string,
        quiet: boolean = false,
        additionalSearchPath: Array<{ modName: string; path: string }> = [],
    ): { content: string; name: string; mod: FactorioMod } | null {
        const fpath = path.replace(/\./g, "/") + ".lua";

        for (const mod of this.availableContexts.concat(this.coreContext)) {
            let searchPaths = [];

            for (const addtnl of additionalSearchPath) {
                if (mod.info.name === addtnl.modName) {
                    searchPaths.push(addtnl.path);
                }
            }
            searchPaths = searchPaths.concat(mod.luaPaths);

            for (const prefix of searchPaths) {
                const script = mod.luaFiles[prefix + fpath];

                if (!quiet) {
                    console.log(`Search for "${prefix + fpath}" in "${mod.info.name}": found=${script !== undefined}`);
                }

                if (script !== undefined) {
                    return {
                        ...script,
                        mod,
                    };
                }
            }
        }

        return null;
    }

    private runModsScriptStage(mods: FactorioMod[], name: string) {
        for (const mod of mods) {
            if (!!mod.luaFiles[name + ".lua"]) {
                this.setModContext(mod);

                // language=Lua
                this.exec_lua(`require('${name}')`);
            }
        }
    }

    private loadSettings(p: FactorioPack, mods: FactorioMod[]) {
        // language=Lua
        this.exec_lua(`settings = { startup = {} }`);

        this.runModsScriptStage(mods, "settings");
        this.runModsScriptStage(mods, "settings-updates");
        this.runModsScriptStage(mods, "settings-final-fixes");

        // language=Lua
        this.exec_lua(`
            function string.ends(String, End)
                return End == '' or string.sub(String, -string.len(End)) == End
            end

            for type, t_val in pairs(data.raw) do
                if string.ends(type, '-setting') then
                    for k, v in pairs(data.raw[type]) do
                        settings.startup[v.name] = {
                            value = v.default_value
                        }
                    end
                end
            end
        `);

        console.log("Settings added to startup");
    }

    private loadData(p: FactorioPack, mods: FactorioMod[]) {
        this.runModsScriptStage(mods, "data");
        this.runModsScriptStage(mods, "data-updates");
        this.runModsScriptStage(mods, "data-final-fixes");
    }

    private setModContext(mod: FactorioMod) {
        console.log(`[Context] Switch to ${mod.info.name}`);

        if (this.availableContexts.length !== 0) {
            // save mod context state

            this.storedContextState[this.availableContexts[0].info.name] = {
                loaded: this.internalLoaded.value,
            };

            const nextContextState = this.storedContextState[mod.info.name];
            if (nextContextState !== undefined) {
                // there's existing context

                this.internalLoaded.value = nextContextState.loaded;
            } else {
                // create new context

                this.internalLoaded.value = luaH_new(this.L);
            }
        }

        this.availableContexts.length = 0;
        this.availableContexts.push(mod);
    }
}
