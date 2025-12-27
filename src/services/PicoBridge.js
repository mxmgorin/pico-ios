import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { haptics } from "../utils/haptics";

/**
 * architecture:
 * 1. prepares window.module with poison protocol.
 * 2. injects cartridge into vfs via poller.
 * 3. clears _cartdat to bypass embedded loader.
 * 4. forces offline mode.
 * 5. boots engine via callmain.
 */
// initialize global bridge namespace, prevents race conditions
window.picoBridge = {
  syncFromNative: async () => {
    console.log(
      "[PicoBridge] bridge warming up... (syncFromNative called early)"
    );
  },
  syncToNative: async () => {
    console.warn(
      "[PicoBridge] bridge warming up... (syncToNative called early)"
    );
  },
};

class Pico8Bridge {
  constructor() {
    this.isActive = false;
    this.isInitialSyncDone = false;
    this.isSyncingInProgress = false;
    this.initGlobalState();
  }

  initGlobalState() {
    // # required by game.js schema
    window.pico8_gpio = new Array(128);
    window.p8_is_running = false;

    // # persistence placeholders
    window.picoSave = () => {
      /* system not ready yet */
    };
    window.picoLoad = () => {
      /* system not ready yet */
    };
  }

  /**
   * boot a cartridge
   * @param {string} cartName - filename (e.g. "celeste.p8")
   * @param {Uint8Array} cartData - binary data
   */
  async boot(cartName, cartData) {
    if (this.isActive) {
      this.shutdown();
    }

    this.isActive = true;
    this.currentCartName = cartName;
    console.log(`[PicoBridge] booting: ${cartName}`);

    // # silence internal engine
    localStorage.setItem("pico8_debug", "0");

    // ## prepare global state for injection
    // # storage for poller to pick up
    window._cartdat = cartData;
    // # force name: fixes boot timeout by ensuring engine finds the expected file
    // regardless of what the user called it (e.g. "My Game.p8.png")
    const safeCartName = "cart.png";
    window._cartname = [safeCartName];

    // ## configure emscripten module
    window.Module = {
      // # dynamic canvas getter
      get canvas() {
        return document.getElementById("canvas");
      },

      // # force pico-8 to use /appdata for saves/config
      // # AND force load the specific file we inject (cart.png)
      arguments: ["-p", "/cart.png"],

      // # race condition fix
      noInitialRun: true,

      preRun: [
        function () {
          console.log("[Pico8Bridge] preRun: starting...");
          // # debugging: global scope check
          const self = window.picoBridge;

          try {
            Filesystem.mkdir({
              path: "Saves",
              directory: Directory.Documents,
              recursive: true,
            }).catch(() => {});
          } catch (e) {}

          // ## pulse-start & anti-stall
          console.log("[PicoBridge] pulse-starting engine...");
          window.pico8_buttons = [0];
          window.pico8_gpio = new Array(128);

          // # force fs release logic
          if (!Module.FS && typeof FS !== "undefined") {
            Module.FS = FS;
            console.log("[PicoBridge] Module.FS = FS (global) forced.");
          }
          // # fallback to window.fs
          if (!Module.FS && window.FS) {
            Module.FS = window.FS;
            console.log("[PicoBridge] Module.FS = window.FS forced.");
          }

          console.log("[Pico8Bridge] preRun: starting vfs poller...");
          let pollCount = 0;
          const MAX_POLLS = 1500;

          // clear previous if exists to prevent zombies
          if (window.pico8_poller) clearInterval(window.pico8_poller);

          window.pico8_poller = setInterval(async () => {
            pollCount++;

            // ## the one true fs check
            const mod = window.Module;
            const engineReady =
              mod && mod.FS && typeof mod.callMain === "function";

            // aggressive cleanup: if engine is already running, stop polling
            if (
              window.p8_is_running &&
              window.pico8_engine_ready &&
              !window._bbs_cartdat &&
              !window._cartdat
            ) {
              // Wait a few cycles to ensure transition, then kill
              if (pollCount > 100) {
                console.log(
                  "🚀 [PicoBoot] Engine running stable, killing poller."
                );
                clearInterval(window.pico8_poller);
                window.pico8_poller = null;
                return;
              }
            }

            let fs = null;
            if (engineReady) {
              fs = mod.FS;
              if (!window.pico8_engine_ready) {
                window.FS = fs;
                window.pico8_engine_ready = true;
                console.log("[PicoBoot] engine ready (module.fs checks out)");
              }
            }

            const canvasEl = document.getElementById("canvas");
            const hasCallMain = engineReady;

            // poller to 'true'
            let cartExists = false;
            try {
              if (fs && fs.analyzePath("/cart.png").exists) {
                cartExists = true;
                if (pollCount % 100 === 0)
                  console.log(
                    "🚀 [PicoBoot] Poller confirmed /cart.png exists on VFS."
                  );
              }
            } catch (e) {}

            const hasCart = !!window._cartdat || cartExists;

            // debug heartbeat (every 1s)
            if (pollCount % 100 === 0) {
              console.log(
                `[PicoBoot] poll #${pollCount}: fs=${!!fs}, canvas=${!!canvasEl}, callmain=${hasCallMain}, cart=${hasCart}`
              );
            }

            // timeout failsafe
            if (pollCount > MAX_POLLS) {
              console.error("[Error] TIMEOUT: engine failed to initialize.");
              clearInterval(window.pico8_poller);
              window.pico8_poller = null;
              haptics.error();
              return;
            }

            // expose sync methods globally
            window.picoSave = () => {
              // block saves during boot
              return Promise.resolve(true);
            };

            // inject cartridge
            if (window._cartdat) {
              try {
                // ensure clean slate
                try {
                  fs.unlink("/cart.png");
                } catch (e) {}

                // the offline patch
                window.lexaloffle_bbs_player = 0;

                // launch logic
                // ensure canvas in dom and engine ready
                if (canvasEl && hasCallMain) {
                  console.log("[Pico8Bridge] poller: launching engine...");

                  // priority 1: bbs download (source of truth)
                  if (window._bbs_cartdat) {
                    console.log("🚀 [PicoBoot] BBS SLOT INSERTION");

                    let mainCart = "/cart.png";
                    const data = window._bbs_cartdat;

                    // multi-file support (object that is not a uint8array)
                    if (
                      typeof data === "object" &&
                      !(data instanceof Uint8Array)
                    ) {
                      console.log("📂 Multi-File VFS detected");
                      for (const [fname, content] of Object.entries(data)) {
                        const path = fname.startsWith("/")
                          ? fname
                          : "/" + fname;
                        try {
                          fs.unlink(path);
                        } catch (e) {}
                        fs.writeFile(path, content);
                        console.log(`   -> wrote ${path}`);

                        // Heuristic: Prefer .p8 or .png as main, default to first if needed
                        if (
                          path === "/cart.p8" ||
                          path === "/cart.png" ||
                          path.endsWith(".p8")
                        ) {
                          mainCart = path;
                        }
                      }
                    } else {
                      // single file handling
                      const isText = typeof data === "string";
                      mainCart = isText ? "/cart.p8" : "/cart.png";

                      try {
                        fs.unlink(mainCart);
                      } catch (e) {}
                      fs.writeFile(mainCart, data);
                      console.log(`   -> wrote single file ${mainCart}`);
                    }

                    // Stop poller & force run
                    clearInterval(window.pico8_poller);
                    window.pico8_poller = null;

                    // Clear both slots to prevent race conditions
                    delete window._bbs_cartdat;
                    delete window._cartdat;

                    window.Module.arguments = [
                      "-p",
                      mainCart,
                      "-run",
                      mainCart,
                    ];
                    window.Module.callMain(window.Module.arguments);
                    return;
                  }

                  // priority 2: local library load
                  if (window._cartdat) {
                    console.log(
                      "🚀 [PicoBoot] LOCAL SLOT INSERTION: /cart.png"
                    );

                    try {
                      fs.unlink("/cart.png");
                    } catch (e) {}
                    fs.writeFile("/cart.png", window._cartdat);

                    clearInterval(window.pico8_poller);
                    window.pico8_poller = null;

                    // Clear local slot
                    delete window._cartdat;

                    window.Module.arguments = [
                      "-p",
                      "/cart.png",
                      "-run",
                      "/cart.png",
                    ];
                    window.Module.callMain(window.Module.arguments);
                    return;
                  }
                }
              } catch (e) {
                console.error("[Error] vfs/boot error:", e);
              }
            }
          }, 10); // poll every 10ms
        },
      ],

      print: (text) => {},
      printErr: (text) => {},
      onRuntimeInitialized: () => {
        // # force fs exposure
        if (window.Module && window.Module.FS) {
          window.FS = window.Module.FS;
          console.log("[PicoBridge] window.FS exposed");
        }

        // # expose ram pointer if available
        try {
          if (typeof window._pico8_ram_ptr === "function") {
            window.pico_ram_ptr = window._pico8_ram_ptr();
            window.pico8_ram_ptr = window.pico_ram_ptr;
          }
        } catch (e) {}

        window.p8_is_running = true;
      },
    };

    // # inject script
    this.injectScript();
  }

  injectScript() {
    const existing = document.getElementById("pico8-engine-script");
    if (existing) existing.remove();

    const script = document.createElement("script");
    script.id = "pico8-engine-script";
    script.src = "/pico8.js";
    script.async = true;
    document.body.appendChild(script);
  }

  shutdown() {
    this.isActive = false;
    window.p8_is_running = false;

    // # kill switch for pico8.js loop
    window.Pico8Kill = true;

    // # stop boot poller if active
    if (window.pico8_poller) {
      clearInterval(window.pico8_poller);
      window.pico8_poller = null;
    }

    // # attempt clean engine pause
    try {
      if (window.Module && window.Module.pauseMainLoop) {
        window.Module.pauseMainLoop();
      }
    } catch (e) {}

    // # audio context cleanup
    if (window.pico8_audio_context) {
      try {
        window.pico8_audio_context.close();
      } catch (e) {}
      window.pico8_audio_context = null;
    }

    // # kill script
    const existing = document.getElementById("pico8-engine-script");
    if (existing) existing.remove();

    // # nuke module
    window.Module = null;
  }

  async resumeAudio() {
    // # ios safari audio unlock
    const ctx =
      window.pico8_audio_context ||
      (window.Module && window.Module.sdl_audio_context);

    if (ctx && ctx.state === "suspended") {
      // silent buffer kickstart (force thread priority)
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);

      await ctx.resume().catch(() => {});
      console.log("[PicoBridge] AudioContext resumed (w/ kickstart)");
    }
  }

  // ## native sync methods
  async syncFromNative() {
    console.log("[PicoBridge] syncFromNative (class method)");
    return Promise.resolve();
  }

  async syncToNative() {
    try {
      const fs = window.Module && window.Module.FS;
      const savesDir = "/appdata";

      // # critical filesystem check
      if (!fs || !fs.analyzePath || !window.pico8_engine_ready) {
        console.warn("[Warning] syncToNative skipped (fs not ready)");
        return;
      }

      try {
        fs.stat(savesDir);
      } catch (e) {
        return;
      }

      const files = fs.readdir(savesDir);
      // console.log(`[Native] scanning /appdata... found ${files.length} items`);

      // # optimization: process non-blocking
      const processFile = async (file) => {
        if (file === "." || file === "..") return;

        return new Promise((resolve) => {
          // # schedule on idle or minimal timeout
          const scheduler = window.requestIdleCallback || setTimeout;
          scheduler(async () => {
            try {
              const path = `${savesDir}/${file}`;
              const data = fs.readFile(path);
              const base64 =
                typeof data === "string"
                  ? btoa(data)
                  : btoa(String.fromCharCode.apply(null, data));

              await Filesystem.writeFile({
                path: `Saves/${file}`,
                data: base64,
                directory: Directory.Documents,
                encoding: "base64",
                recursive: true,
              });
              resolve();
            } catch (e) {
              console.warn(`failed to sync ${file}`, e);
              resolve(); // proceed anyway
            }
          });
        });
      };

      // # serial execution to prevent memory spiking
      for (const file of files) {
        await processFile(file);
      }
    } catch (e) {
      console.warn("syncToNative failed", e);
    }
  }

  /**
   * helper: find pico-8 ram base pointer
   * heuristic: scan heap for pico-8 header or use symbol
   */
  _findRAMPointer() {
    const m = window.Module;
    if (!m || !m.HEAPU8) throw new Error("Emscripten not ready");

    // 1. try standard export functions
    if (typeof m._pico8_ram_ptr === "function") return m._pico8_ram_ptr();
    if (typeof m._pico8_ram === "number") return m._pico8_ram;

    // # check for gpio function export
    if (typeof m._pico8_gpio === "function") {
      const gpioPtr = m._pico8_gpio();
      if (gpioPtr > 0x5f80) return gpioPtr - 0x5f80;
    }

    // 2. ## the memory hunter
    try {
      const heap = m.HEAPU8;
      // heuristic: look for default palette at 0x5f00

      const sigLen = 16;
      const heapLen = heap.length;

      for (let i = 0; i < heapLen - 0x8000; i += 8) {
        if (
          heap[i] === 0 &&
          heap[i + 1] === 1 &&
          heap[i + 2] === 2 &&
          heap[i + 3] === 3
        ) {
          let match = true;
          for (let j = 4; j < sigLen; j++) {
            if (heap[i + j] !== j) {
              match = false;
              break;
            }
          }
          if (match) {
            const base = i - 0x5f00;
            if (base >= 0) {
              console.log(
                `[Memory Hunter] found ram base at 0x${base.toString(16)}`
              );
              return base;
            }
          }
        }
      }
    } catch (e) {
      console.warn("[PicoBridge] RAM Scan Warning:", e);
    }

    // # last ditch: if pico8_gpio global is typedarray
    if (window.pico8_gpio && window.pico8_gpio.byteOffset) {
      return window.pico8_gpio.byteOffset - 0x5f80;
    }

    throw new Error("Could not locate PICO-8 RAM pointer");
  }

  /*
   * helper: standardize save state path
   * strips extensions and appends _manual.state
   */
  getCleanStatePath(cartName) {
    if (!cartName) return "uknown_cart_manual.state";
    // # strip common extensions
    const cleanName = cartName.replace(/(\.p8\.png|\.p8|\.png)$/i, "");
    return `Saves/${cleanName}_manual.state`;
  }

  async captureFullRAMState() {
    try {
      if (!window.Module || !window.Module.HEAPU8)
        throw new Error("Emscripten not ready");

      // ## full heap snapshot + gzip compression
      console.log("[Memory Hunter] capturing full execution heap...");

      // 1. create copy of heap
      const heapData = new Uint8Array(window.Module.HEAPU8);

      // 2. gzip compression
      const b64Promise = new Promise(async (resolve, reject) => {
        try {
          const blob = new Blob([heapData]);
          const compressedStream = blob
            .stream()
            .pipeThrough(new CompressionStream("gzip"));
          const compressedBlob = await new Response(compressedStream).blob();

          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.split(",")[1];
            resolve(base64);
          };
          reader.onerror = (e) => reject(e);
          reader.readAsDataURL(compressedBlob);
        } catch (e) {
          reject(e);
        }
      });

      const b64 = await b64Promise;

      const filename = this.getCleanStatePath(this.currentCartName);
      console.log(
        `[PicoBridge] saving compressed state (${(
          b64.length /
          1024 /
          1024
        ).toFixed(2)} MB) to: ${filename}`
      );

      await Filesystem.writeFile({
        path: filename,
        data: b64,
        directory: Directory.Documents,
        recursive: true,
      });

      console.log(`[Native] full state save success`);
      haptics.success();
      return true;
    } catch (e) {
      console.error("[Error] full state capture failed:", e);
      haptics.error();
      return false;
    }
  }

  async loadRAMState(pathOverride = null) {
    try {
      if (!window.Module || !window.Module.HEAPU8)
        throw new Error("Emscripten not ready");

      const filename =
        pathOverride || this.getCleanStatePath(this.currentCartName);
      console.log(`[PicoBridge] loading state: ${filename}`);

      const result = await Filesystem.readFile({
        path: filename,
        directory: Directory.Documents,
      });

      // ## robust decompression (manual stream)
      console.log("[PicoBridge] decompressing (manual mode)...");

      // 1. manual base64 decode
      const binaryString = window.atob(result.data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      let loadedHeap;

      try {
        // 2. decompress via stream
        const ds = new DecompressionStream("gzip");
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();

        // 3. read chunks
        const reader = ds.readable.getReader();
        const chunks = [];
        let totalSize = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalSize += value.length;
        }

        // 4. flatten
        const rawData = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          rawData.set(chunk, offset);
          offset += chunk.length;
        }

        loadedHeap = rawData;
        console.log("[PicoBridge] decompression success");
      } catch (e) {
        console.warn("[Warning] decompression failed, falling back to raw.", e);
        loadedHeap = bytes;
      }

      console.log(`[Memory Hunter] heap size: ${loadedHeap.length} bytes`);

      if (loadedHeap.length !== window.Module.HEAPU8.length) {
        console.warn(
          `[PicoBridge] heap size mismatch! current: ${window.Module.HEAPU8.length}, saved: ${loadedHeap.length}`
        );
      }

      // ## memory transplant
      this.pause();

      const target = window.Module.HEAPU8;
      if (loadedHeap.length <= target.length) {
        target.set(loadedHeap);
      } else {
        console.warn(
          "[PicoBridge] clamping saved heap to fit current allocator."
        );
        target.set(loadedHeap.subarray(0, target.length));
      }

      // # force draw
      if (window.Module._pico8_draw) window.Module._pico8_draw();
      else if (window.Module._draw) window.Module._draw();

      this.resume();

      console.log("[PicoBridge] state injection complete");
      haptics.success();
      return true;
    } catch (e) {
      console.error("[Error] state load failed:", e);
      haptics.error();
      return false;
    }
  }

  // ## legacy injection (compat)
  async injectFullRAMState(ramData) {
    try {
      if (!window.Module || !window.Module.HEAPU8)
        throw new Error("Emscripten not ready");

      const ramBase = this._findRAMPointer();
      console.log(`[Memory Hunter] injecting ram at 0x${ramBase.toString(16)}`);

      if (ramData.length !== 0x8000) {
        console.warn(
          `[PicoBridge] ram size mismatch! got ${ramData.length}, expected 32768`
        );
      }
      this.pause();
      window.Module.HEAPU8.set(ramData, ramBase);
      this.resume();
      console.log("[PicoBridge] ram injection complete");
      haptics.success();
    } catch (e) {
      console.error("[Error] ram injection failed:", e);
      haptics.error();
    }
  }

  pause() {
    try {
      if (window.Module && window.Module.pauseMainLoop) {
        window.Module.pauseMainLoop();
      }
      // # suspend audio
      const ctx =
        window.pico8_audio_context ||
        (window.Module && window.Module.sdl_audio_context);
      if (ctx && ctx.state === "running") ctx.suspend();
    } catch (e) {
      console.warn("wm: pause failed", e);
    }
  }

  resume() {
    try {
      if (window.Module && window.Module.resumeMainLoop) {
        window.Module.resumeMainLoop();
      }
      this.resumeAudio();
    } catch (e) {
      console.warn("wm: resume failed", e);
    }
  }
}

// singleton export
export const picoBridge = new Pico8Bridge();

// # global access (for debugging)
window.Pico8Bridge = picoBridge;
window.picoBridge = picoBridge;
