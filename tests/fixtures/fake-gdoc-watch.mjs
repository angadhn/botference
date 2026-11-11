// Stands in for core/gdoc_watch.py `run` in the council's tests: writes its
// pid as one line to the file named first, then stays alive (or, with
// "exit" second, exits at once so the keeper has to start it again).
import fs from 'node:fs';

const [file, how] = process.argv.slice(2);
fs.appendFileSync(file, `${process.pid}\n`);
if (how === 'exit') process.exit(1);
setInterval(() => { }, 1000);
