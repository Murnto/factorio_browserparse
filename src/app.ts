import "source-map-support/register";
import "es7-object-polyfill";
import { dumpMemUsage } from "./utils";
import { FactorioPack } from "./factorioPack";

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

    // noinspection TypeScriptUnresolvedVariable
    await Promise.all(promises);

    console.timeEnd("Load zips");
    dumpMemUsage("After basic load");

    console.time("pack.resolveMods()");
    await pack.resolveMods();
    console.timeEnd("pack.resolveMods()");
    dumpMemUsage("After resolve");

    console.time("pack.loadLocale()");
    await pack.loadLocale("en");
    console.timeEnd("pack.loadLocale()");
    dumpMemUsage("After locale");

    console.time("pack.loadData()");
    await pack.loadData();
    console.timeEnd("pack.loadData()");
    dumpMemUsage("After data");

    global.gc();
    dumpMemUsage("After gc");
}

test();
