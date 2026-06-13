import { afterAll, afterEach } from "vitest";
import { flushTmpDirs } from "./helpers/tmp.js";

afterEach(() => {
  flushTmpDirs();
});

afterAll(() => {
  flushTmpDirs();
});
