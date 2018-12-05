import "source-map-support/register";
import "es7-object-polyfill";
import * as JSZip from "jszip";
import { lua_stack_trace_introspect, lua_value_to_js, push_js_object } from "./lua_utils";
import { dumpMemUsage } from "./utils";
// @ts-ignore
import fengari from "fengari";
// @ts-ignore
import { luaS_newliteral } from "fengari/src/lstring";
// @ts-ignore
import { luaH_getstr, luaH_new } from "fengari/src/ltable";

import * as fs from "fs";

const {
    to_luastring,
    lua,
    lauxlib: {
        luaL_newstate,
        luaL_loadstring,
        luaL_loadbuffer,
    },
    lualib: {
        luaL_openlibs,
    },
} = fengari;

interface ModInfo {
    name: string
    title: string
    author: string
    version: string
    description?: string
    contact: string
    homepage: string
    dependencies: string[]
}

interface FactorioModDependency {
    optional: boolean;
    name: string;
    version?: string;
    relation?: string;
}

interface LuaScript {
    name: string;
    content: string;
}

class FactorioMod {
    public info!: ModInfo;
    public luaFiles: { [index: string]: LuaScript } = {};
    public dependencies!: FactorioModDependency[];
    public luaPaths: string[] = [""];
    private loadedZip!: JSZip | null;
    private topLevelPrefix: string = "";

    public async load(zipPath: string, debugTiming: boolean = false) {
        if (debugTiming) {
            console.time(`Load zip: ${zipPath}`);
        }
        const data = fs.readFileSync(zipPath);
        if (debugTiming) {
            console.timeEnd(`Load zip: ${zipPath}`);
        }

        if (debugTiming) {
            console.time(`Parse zip: ${zipPath}`);
        }
        this.loadedZip = await new JSZip()
            .loadAsync(data);

        this.detectToplevelFolder();
        if (debugTiming) {
            console.timeEnd(`Parse zip: ${zipPath}`);
        }

        if (debugTiming) {
            console.time(`Decompress lua scripts: ${zipPath}`);
        }
        await Promise.all(this.loadedZip.filter((relativePath, file) =>
            relativePath.endsWith(".lua"),
        ).map(async file => {
            let name = file.name;

            if (name.startsWith(this.topLevelPrefix)) {
                name = name.replace(this.topLevelPrefix, "");
            }

            this.luaFiles[name] = {
                content: await file.async("text"),
                name,
            };
        }));
        if (debugTiming) {
            console.timeEnd(`Decompress lua scripts: ${zipPath}`);
        }

        const infoFile = this.loadedZip.file("info.json");
        const infoString = await infoFile.async("text");
        this.info = JSON.parse(infoString);

        (this.loadedZip as any).files = null;
        this.loadedZip = null;

        this.parseDependencies();
    }

    private parseDependencies() {
        const depPattern = /^(?:(\?)\s*)?(.*?)(?:\s*(<=|=|>=)\s*(.*?))?$/;

        this.dependencies = [];

        if (this.info.dependencies === undefined) {
            return;
        }

        for (const dep of this.info.dependencies) {
            const match = dep.match(depPattern);

            if (match !== null) {
                this.dependencies.push({
                    name: match[2],
                    optional: match[1] === "?",
                    relation: match[3],
                    version: match[4],
                });
            } else {
                throw new Error(`Failed to parse dependency "${dep}"`);
            }
        }
    }

    private detectToplevelFolder() {
        // let found: JSZip.JSZipObject | null = null;

        for (const file of Object.values(this.loadedZip!.files)) {
            if (file.name.endsWith("info.json") && file.name.indexOf("/") === file.name.lastIndexOf("/")) {
                this.topLevelPrefix = file.name.slice(0, file.name.lastIndexOf("info.json"));

                // console.info(`Using toplevel folder ${this.topLevelPrefix}`);
                this.loadedZip = this.loadedZip!.folder(this.topLevelPrefix);
            }
        }
    }
}

type DefinesDef = string[] | { [index: string]: DefinesDef }

class FactorioModLua {
    public L: any;
    private availableContexts: FactorioMod[] = [];
    private coreContext!: FactorioMod;
    private storedContextState: { [index: string]: any } = {};
    private internalLoaded: any;

    public init() {
        const L = this.L = luaL_newstate();
        lua.lua_checkstack(this.L, 100);
        luaL_openlibs(L);
        // Report native errors
        lua.lua_atnativeerror(L, (L: any) => {
            console.error(lua.lua_touserdata(L, 1));
            return 1;
        });

        this.init_defines({
            difficulty_settings: {
                recipe_difficulty: [
                    "normal", "expensive",
                ],
                technology_difficulty: [
                    "normal", "expensive",
                ],
            },
            direction: [
                "north", "south", "east", "west",
            ],
            inventory: [
                "fuel", "burnt_result", "chest", "furnace_source", "furnace_result", "furnace_modules", "player_quickbar", "player_main", "player_guns", "player_ammo", "player_armor", "player_tools", "player_vehicle", "player_trash", "god_quickbar", "god_main", "roboport_robot", "roboport_material", "robot_cargo", "robot_repair", "assembling_machine_input", "assembling_machine_output", "assembling_machine_modules", "lab_input", "lab_modules", "mining_drill_modules", "item_main", "rocket_silo_rocket", "rocket_silo_result", "rocket", "car_trunk", "car_ammo", "cargo_wagon", "turret_ammo", "beacon_modules", "character_corpse",
            ],
        });
        this.exec_lua(`function log(x) end`);
        this.exec_lua(`function table_size(T)
    local count = 0
    for _ in pairs(T) do count = count + 1 end
    return count
  end`);

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

        this.exec_lua(`require('dataloader')`);
        this.exec_lua(`require('data')`);

        // this.storeSharedGlobal('mods');
        // this.storeSharedGlobal('data');

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

                additionalSearchPath.push({
                    modName: source.slice(1, source.indexOf("/")),
                    path: source.slice(source.indexOf("/") + 1, source.lastIndexOf("/") + 1),
                });

                break;
            }
        }

        // TODO find path of requiring file and also search there

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

        return 2;  /* return open function and file name */
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

    private find_script_in_context(path: string, quiet: boolean = false, additionalSearchPath: Array<{ modName: string, path: string }> = []): { content: string, name: string, mod: FactorioMod } | null {
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

                this.exec_lua(`require('${name}')`);
            }
        }
    }

    private loadSettings(p: FactorioPack, mods: FactorioMod[]) {
        this.exec_lua(`settings = {startup = {}}`);

        this.runModsScriptStage(mods, "settings");
        this.runModsScriptStage(mods, "settings-updates");
        this.runModsScriptStage(mods, "settings-final-fixes");

        // TODO parse settings
        this.exec_lua(`function string.ends(String,End)
   return End=='' or string.sub(String,-string.len(End))==End
end`);
        this.exec_lua(`
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

function compareVersions(target: string, version: string): number {
    if (target === version) { return 0; }

    const tSplit = target.split(".");
    const vSplit = version.split(".");
    const minLength = Math.min(tSplit.length, vSplit.length);

    for (let i = 0; i < minLength; i++) {
        const t = parseInt(tSplit[i], 10);
        const v = parseInt(vSplit[i], 10);

        if (t === v) { continue; }
        if (t < v) { return 1; }
        if (t > v) { return -1; }
    }

    if (tSplit.length < vSplit.length) { return 1; }
    if (tSplit.length > vSplit.length) { return -1; }

    return 0;
}

class FactorioPack {
    public mods: { [index: string]: FactorioMod } = {};
    public modLoadOrder: string[] = ["core"]; // core is always first

    public async loadModArchive(zipPath: string) {
        // console.time(`Loading archive: ${zipPath}`);
        const mod = new FactorioMod();

        await mod.load(zipPath);

        this.addMod(mod);
        // console.timeEnd(`Loading archive: ${zipPath}`);
    }

    public addMod(mod: FactorioMod) {
        this.mods[mod.info.name] = mod;
    }

    public resolveMods() {
        const remaining = Object.keys(this.mods);
        remaining.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

        let priorProgress = -1;

        while (remaining.length) {
            if (priorProgress === remaining.length) {
                throw new Error(`Stuck resolving remaining mods: ${remaining}`);
            }
            priorProgress = remaining.length;

            for (const name of remaining) {
                const mod = this.mods[name];

                if (this.modLoadOrder.indexOf(name) !== -1) {
                    // skip mods that are already loaded
                    remaining.splice(remaining.indexOf(name), 1);
                    continue;
                }

                let fail = false;
                for (const dep of mod.dependencies) {
                    if (this.mods[dep.name] === undefined) {
                        if (dep.optional) {
                            continue; // skip missing optional dependency
                        } else {
                            throw new Error(`Dependency check failed! "${name}" requires unknown mod "${dep.name}"`);
                        }
                    }

                    if (this.modLoadOrder.indexOf(dep.name) === -1) {
                        fail = true;

                        break; // dependency not loaded yet
                    }

                    if (dep.version !== undefined) {
                        const depMod = this.mods[dep.name];
                        const versionComparison = compareVersions(dep.version, depMod.info.version);

                        switch (dep.relation) {
                            case "=":
                                if (versionComparison !== 0) {
                                    throw new Error(`Dependency check failed! "${name}" requires version "${dep.version}" of "${dep.name}", but found "${depMod.info.version}" instead`);
                                }
                                break;
                            case ">=":
                                if (versionComparison < 0) {
                                    throw new Error(`Dependency check failed! "${name}" requires at least version "${dep.version}" of "${dep.name}", but found "${depMod.info.version}" instead`);
                                }
                                break;
                            default:
                                throw new Error(`Unknown dependency relation "${dep.relation}"`);
                        }
                    }
                }

                if (fail) {
                    continue; // can't load this mod at this time
                }

                this.modLoadOrder.push(name);
                remaining.splice(remaining.indexOf(name), 1);
                // console.log(`Load: "${name}"`);
                break;
            }
        }
    }

    public loadMods() {
        // TODO load locale

        const mods = this.modLoadOrder.map(k => this.mods[k]);

        const factorioLua = new FactorioModLua();
        factorioLua.init();
        dumpMemUsage("After lua init");
        factorioLua.load_mods(this, mods);

        dumpMemUsage("After mod load");

        lua.lua_getglobal(factorioLua.L, "data");
        const jsonData = JSON.stringify(lua_value_to_js(factorioLua.L, -1));

        fs.writeFileSync("data.json", jsonData);

        factorioLua.close();

        dumpMemUsage("Before gc");
        global.gc();
        dumpMemUsage("After gc");
    }
}

async function test() {
    const pack = new FactorioPack();

    console.time("Load zips");

    const promises = [];
    promises.push(pack.loadModArchive("core-0.16.51.zip"));
    promises.push(pack.loadModArchive("base-0.16.51.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/angelsaddons-warehouses_0.3.0.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/angelsbioprocessing_0.5.9.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/angelspetrochem_0.7.12.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/angelsrefining_0.9.14.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/angelssmelting_0.4.6.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/A Sea Block Config_0.2.4.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobassembly_0.16.1.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobelectronics_0.16.0.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobenemies_0.16.0.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobinserters_0.16.8.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/boblibrary_0.16.6.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/boblogistics_0.16.23.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobmining_0.16.0.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobmodules_0.16.0.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobplates_0.16.5.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobpower_0.16.8.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobrevamp_0.16.3.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobtech_0.16.6.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/bobwarfare_0.16.7.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/CircuitProcessing_0.1.2.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/Explosive Excavation_1.1.4.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/Foreman_3.0.2.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/FNEI_0.1.9.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/KS_Power_0.2.4.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/LandfillPainting_0.2.5.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/LoaderRedux_1.3.1.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/LogisticTrainNetwork_1.9.3.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/LTN-easier_0.1.0.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/Nanobots_2.0.7.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/Nuclear Fuel_0.1.3.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/ScienceCostTweakerM_0.16.47.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/SeaBlock_0.2.16.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/SeaBlockMetaPack_0.16.0.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/ShinyAngelGFX_0.16.8.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/ShinyBobGFX_0.16.21.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/ShinyIcons_0.16.20.zip"));
    promises.push(pack.loadModArchive("/media/data/factorio/mods/seablock_16/SpaceMod_0.3.12.zip"));

    await Promise.all(promises);

    console.timeEnd("Load zips");

    dumpMemUsage("After basic load");

    console.time("pack.resolveMods()");
    await pack.resolveMods();
    console.timeEnd("pack.resolveMods()");

    dumpMemUsage("After resolve");

    console.time("pack.loadMods()");
    await pack.loadMods();
    console.timeEnd("pack.loadMods()");

    dumpMemUsage("After dump");
}

test();
