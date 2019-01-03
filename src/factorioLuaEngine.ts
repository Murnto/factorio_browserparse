import { FactorioPack } from "./factorioPack";
import { lua_stack_trace_introspect, lua_value_to_js, mostRecentFileInStackTrace, push_js_object } from "./luaUtils";
import { FactorioMod } from "./factorioMod";
import apiDefines from "./apiDefines";
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

export class FactorioLuaEngine {
    private availableContexts: FactorioMod[] = [];
    private readonly coreContext!: FactorioMod;
    private internalLoaded: any;
    private L: any;
    private readonly orderedMods: FactorioMod[];
    private storedContextState: { [index: string]: any } = {};

    constructor(p: FactorioPack) {
        this.orderedMods = p.modLoadOrder.map(k => p.mods[k]);

        // extract the core "mod" so it can be handled separately
        this.coreContext = this.orderedMods.splice(0, 1)[0];
        this.coreContext.luaPaths.push("lualib/");
    }

    public load(): any {
        const settings = this.loadSettings();

        return this.loadData(settings);
    }

    private close() {
        this.storedContextState = {};
        this.internalLoaded = null;
        lua.lua_close(this.L);
    }

    private contextExec(context: FactorioMod, code: string) {
        if (!this.availableContexts || this.availableContexts[0] !== context) {
            this.setModContext(context);
        }

        return this.execLua(code);
    }

    private execLua(code: string) {
        luaL_loadstring(this.L, to_luastring(code));

        const result = lua.lua_pcall(this.L, 0, lua.LUA_MULTRET, 0);

        if (result) {
            lua_stack_trace_introspect(this.L);
            throw new Error(`Failed to run script:  ${lua.lua_tojsstring(this.L, -1)}`);
        }
    }

    private findScriptInContext(path: string, quiet: boolean = false, additionalSearchPath: Array<{ modName: string; path: string }> = []): { content: string; mod: FactorioMod; name: string } | null {
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

                if (script === undefined) {
                    continue;
                }

                return {
                    ...script,
                    mod,
                };
            }
        }

        return null;
    }

    private hookRequire() {
        const L = this.L;

        // language=Lua
        this.execLua(`
            package.searchers[3] = nil
            package.searchers[4] = nil
        `);

        // TODO improve table access
        lua.lua_getglobal(L, "package");
        lua.lua_pushstring(L, "searchers");
        lua.lua_gettable(L, -2);
        lua.lua_pushnumber(L, 2);
        lua.lua_pushcfunction(L, this.luaRequire.bind(this));
        lua.lua_settable(L, -3);

        lua.lua_pop(L, 2);
    }

    private init() {
        const L = (this.L = luaL_newstate());
        lua.lua_checkstack(this.L, 100);
        luaL_openlibs(L);
        // Report native errors
        lua.lua_atnativeerror(L, (l: any) => {
            console.error(lua.lua_touserdata(l, 1));
            return 1;
        });

        this.initDefines(apiDefines);

        // language=Lua
        this.execLua(`
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

        this.hookRequire();

        this.internalLoaded = luaH_getstr(L.l_G.l_registry.value, luaS_newliteral(L, "_LOADED"));

        const modsList = {};
        for (const mod of this.orderedMods) {
            modsList[mod.info.name] = mod.info.version;
        }
        push_js_object(L, modsList);
        lua.lua_setglobal(L, "mods");
    }

    private initDefines(data: DefinesDef, key?: string) {
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

                this.initDefines(data[k], k);
            }
        }

        lua.lua_pop(L, 1);
    }

    private loadData(settings: any): any {
        this.init();

        push_js_object(this.L, settings);
        lua.lua_setglobal(this.L, "settings");

        // language=Lua
        this.contextExec(
            this.coreContext,
            `
                require('dataloader')
                require('data')
            `,
        );

        this.runModsScriptStage(this.orderedMods, "data");
        this.runModsScriptStage(this.orderedMods, "data-updates");
        this.runModsScriptStage(this.orderedMods, "data-final-fixes");

        lua.lua_getglobal(this.L, "data");
        lua.lua_pushstring(this.L, "raw");
        lua.lua_gettable(this.L, -2);

        const data = lua_value_to_js(this.L, -1);
        lua.lua_pop(this.L, 1);
        this.close();

        return data;
    }

    private loadSettings(): any {
        this.init();

        // language=Lua
        this.contextExec(this.coreContext, `require('dataloader')`);

        this.runModsScriptStage(this.orderedMods, "settings");
        this.runModsScriptStage(this.orderedMods, "settings-updates");
        this.runModsScriptStage(this.orderedMods, "settings-final-fixes");

        // language=Lua
        this.execLua(`
            function string.ends(String, End)
                return End == '' or string.sub(String, -string.len(End)) == End
            end

            settings = { startup = {} }

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

        lua.lua_getglobal(this.L, "settings");
        const settings = lua_value_to_js(this.L, -1);
        lua.lua_pop(this.L, 1);
        this.close();

        return settings;
    }

    private luaRequire(L: any) {
        const path = lua.lua_tojsstring(L, -1);
        // console.log(`${this.availableContexts[0].info.name}: require("${path}")`);

        lua.lua_pop(L, 1);

        const additionalSearchPath = [];
        const requiringFile = mostRecentFileInStackTrace(L);

        if (requiringFile) {
            additionalSearchPath.push({
                modName: requiringFile.slice(1, requiringFile.indexOf("/")),
                path: requiringFile.slice(requiringFile.indexOf("/") + 1, requiringFile.lastIndexOf("/") + 1),
            });
        }

        const result = this.findScriptInContext(path, true, additionalSearchPath);

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

    private runModsScriptStage(mods: FactorioMod[], name: string) {
        for (const mod of mods) {
            if (!!mod.luaFiles[name + ".lua"]) {
                // language=Lua
                this.contextExec(mod, `require('${name}')`);
            }
        }
    }

    private setModContext(mod: FactorioMod) {
        // console.log(`[Context] Switch to ${mod.info.name}`);

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
