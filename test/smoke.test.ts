import { test, expect } from "bun:test";
import { Singleflight } from "@coderbuzz/kvs-client";

test("Singleflight deduplicates", async () => {
  const sf = new Singleflight<number>();
  let count = 0;
  const results = await Promise.all([
    sf.do("k", async () => { count++; return 1; }),
    sf.do("k", async () => { count++; return 2; }),
  ]);
  expect(count).toBe(1);
  expect(results).toEqual([1, 1]);
});