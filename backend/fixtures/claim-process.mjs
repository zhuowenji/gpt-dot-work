// Fixed test fixture outside test discovery: claims one task, never evaluates instructions.
import { TaskStore } from '../store.mjs';
const store = new TaskStore(process.argv[2]);
const claim = store.claim(`test-process-${process.pid}`, 120000);
process.stdout.write(JSON.stringify(claim?.task.id ?? null));
store.close();
