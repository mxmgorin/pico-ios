import { test, expect } from "@playwright/test";

test.describe("PICO-8 Boot Process", () => {
  test("should boot engine, clear data, and reboot without crash", async ({
    page,
  }) => {
    // 1. Initial Load (Mocking the environment if needed, but we'll try to run against dev server)
    // Note: This test assumes npm run dev is accessible at localhost:5173
    // and that we can access window.Pico8Bridge
    await page.goto("http://localhost:5173/");

    // MOCK: Filesystem and Haptics for Browser Environment
    await page.addInitScript(() => {
      window.Capacitor = {
        isPluginAvailable: () => true,
        Plugins: {
          Filesystem: {
            readFile: async () => ({ data: "FAKE_BASE64_DATA" }),
            writeFile: async () => {},
            mkdir: async () => {},
            stat: async () => ({ size: 35000 }),
          },
          Haptics: {
            impact: async () => {},
            notification: async () => {},
          },
        },
      };
      // Mock VFS if not present (Emscripten usually adds it later)
      window.FS = {
        writeFile: () => {},
        unlink: () => {},
        mkdir: () => {},
        mount: () => {},
        syncfs: (p, cb) => cb(null),
        stat: () => ({ size: 35000 }),
        readFile: () => new Uint8Array(35000),
      };
    });

    // 2. BOOT 1
    console.log("Starting Boot 1...");
    await page.evaluate(async () => {
      const fakeData = new Uint8Array(35000).fill(0); // Mock Cart Data
      await window.Pico8Bridge.boot("test_cart_1.p8", fakeData);
    });

    // Expect: Module to be defined and arguments set
    const args1 = await page.evaluate(() => window.Module.arguments);
    expect(args1).toContain("/cart.png");
    expect(args1).toContain("-run");

    // Wait for the Offline Patch to apply (Async Poller)
    await page.waitForFunction(
      () => typeof window.lexaloffle_bbs_player !== "undefined"
    );

    const offline1 = await page.evaluate(() => window.lexaloffle_bbs_player);
    expect(offline1).toBe(0);

    // 3. SHUTDOWN
    await page.evaluate(() => window.Pico8Bridge.shutdown());
    const running = await page.evaluate(() => window.p8_is_running);
    expect(running).toBe(false);

    // 4. BOOT 2 (Verify no pollution)
    console.log("Starting Boot 2...");
    await page.evaluate(async () => {
      const fakeData = new Uint8Array(35000).fill(1); // Different Data
      await window.Pico8Bridge.boot("test_cart_2.p8", fakeData);
    });

    // Expect: window._cartdat to be cleared (Antidote)
    // Wait for Poller to finish usually takes ~50-100ms
    await page.waitForTimeout(500);

    const cartDat = await page.evaluate(() => window._cartdat);
    expect(cartDat).toBeUndefined(); // Antidote check
  });
});
