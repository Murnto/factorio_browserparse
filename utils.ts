export function dumpMemUsage(tag?: string) {
    const used = Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
    console.log(`${tag ? (tag + ' ') : ''}The script uses approximately ${used} MB`);
}
