import { WebWorkerMLCEngineHandler } from '/vendor/web-llm.js';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (event) => handler.onmessage(event);
