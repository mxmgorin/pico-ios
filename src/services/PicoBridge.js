import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { haptics } from "../utils/haptics";

/**
 * the golden bridge (pico-8 interface)
 * ------------------------------------
 * phase 73 stable release
 *
 * architecture:
 * 1. prepares window.module with "poison/antidote" protocol.
 * 2. injects cartridge into vfs via poller (phase 68).
 * 3. clears _cartdat to bypass embedded loader (phase 72).
 * 4. forces offline mode (phase 73).
 * 5. boots engine via callmain.
 */
class Pico8Bridge {
  constructor() {
    this.isActive = false;
    this.initGlobalState();
  }

  initGlobalState() {
    // required by game.js schema
    window.pico8_gpio = new Array(128);
    window.p8_is_running = false;

    // persistence placeholders (quiet default)
    window.picoSave = () => {
      /* system not ready yet, ignoring auto-save */
    };
    window.picoLoad = () => {
      /* system not ready yet */
    };
  }

  /**
   * Main Entry Point: Boot a cartridge
   * @param {string} cartName - Filename (e.g. "celeste.p8")
   * @param {Uint8Array} cartData - Binary data of the cartridge
   */
  async boot(cartName, cartData) {
    if (this.isActive) {
      this.shutdown();
    }

    this.isActive = true;
    console.log(`✅[HEARTBEAT] Booting: ${cartName}`);

    // Phase 76: Silence Internal Engine
    localStorage.setItem("pico8_debug", "0");
    this.isActive = true;

    // 1. Prepare Global State for Injection
    // storage for the Phase 68 Poller to pick up
    window._cartdat = cartData;
    window._cartname = ["cart.png"]; // Force .png to avoid text-parser issues

    // 2. Configure Emscripten Module
    window.Module = {
      // Dynamic Canvas Getter
      get canvas() {
        return document.getElementById("canvas");
      },

      // Phase 98: Force PICO-8 to use /appdata for saves/config
      arguments: ["-run", "/cart.png", "-home", "/appdata"],

      // Phase 72: Race Condition Fix
      noInitialRun: true,

      preRun: [
        function () {
          console.log("[Pico8Bridge] preRun: Starting VFS Poller...");

          const poller = setInterval(() => {
            if (window.FS) {
              // a. mount idbfs (save data)
              try {
                // user request: mount /appdata for persistence
                window.FS.mkdir("/appdata");
                window.FS.mount(window.Module.IDBFS, {}, "/appdata");

                // initial sync (read from disk)
                window.FS.syncfs(true, async (err) => {
                  if (!err) {
                    console.log(
                      "✅ [pico8bridge] save system mounted (/appdata)"
                    );
                    // phase 96: pull from native saves immediately after mounting
                    await window.picoBridge.syncFromNative();
                  }
                });

                // helper: sync internal vfs -> native documents/saves
                window.picoBridge.syncToNative = async () => {
                  try {
                    const savesDir = "/appdata";
                    const files = window.FS.readdir(savesDir); // list all files
                    console.log(
                      `💾 [pico8bridge] scanning /appdata... found ${files.length} items`
                    );

                    for (const file of files) {
                      if (file === "." || file === "..") continue;

                      const path = `${savesDir}/${file}`;
                      const data = window.FS.readFile(path); // uint8array
                      const base64 =
                        typeof data === "string"
                          ? btoa(data)
                          : btoa(String.fromCharCode.apply(null, data));

                      // ensure native saves directory exists
                      try {
                        await Filesystem.mkdir({
                          path: "Saves",
                          directory: Directory.Documents,
                          recursive: true,
                        });
                      } catch (e) {}

                      // write to native
                      await Filesystem.writeFile({
                        path: `Saves/${file}`,
                        data: base64,
                        directory: Directory.Documents,
                      });
                      console.log(
                        `💾 [pico8bridge] exported ${file} to native saves`
                      );
                    }
                  } catch (e) {
                    console.error("❌ nativesync export failed:", e);
                  }
                };

                // helper: sync native documents/saves -> internal vfs
                window.picoBridge.syncFromNative = async () => {
                  try {
                    // list native save files
                    const result = await Filesystem.readdir({
                      path: "Saves",
                      directory: Directory.Documents,
                    });

                    for (const file of result.files) {
                      const filename = file.name;
                      // read from native
                      const data = await Filesystem.readFile({
                        path: `Saves/${filename}`,
                        directory: Directory.Documents,
                      });

                      // convert base64 -> uint8array
                      const binaryString = window.atob(data.data);
                      const len = binaryString.length;
                      const bytes = new Uint8Array(len);
                      for (let i = 0; i < len; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }

                      // write to vfs
                      window.FS.writeFile(`/appdata/${filename}`, bytes);
                      console.log(
                        `📂 [pico8bridge] imported ${filename} from native saves`
                      );
                    }
                  } catch (e) {
                    // console.log("no native saves found or read failed", e);
                  }
                };

                // expose sync methods globally
                window.picoSave = () => {
                  console.log("💾 [pico8bridge] syncing to disk...");
                  window.FS.syncfs(false, async (err) => {
                    if (err) console.error("❌ save failed:", err);
                    else {
                      console.log("✅ idbfs save complete.");
                      // trigger native export
                      await window.picoBridge.syncToNative();
                    }
                  });
                };

                window.picoLoad = () => {
                  console.log("📂 [pico8bridge] loading from disk...");
                  // pull from native first
                  window.picoBridge.syncFromNative().then(() => {
                    window.FS.syncfs(true, (err) => {
                      if (err) console.error("❌ load failed:", err);
                      else {
                        console.log("✅ load complete. rebooting to apply...");
                        // reload page to force engine restart with new data
                        // this is the only reliable way to "load" a save currently active in ram
                        window.location.reload();
                      }
                    });
                  });
                };
              } catch (e) {
                // ignore if already mounted
              }

              // b. inject cartridge (phase 68)
              if (window._cartdat) {
                try {
                  // Ensure clean slate
                  try {
                    window.FS.unlink("/cart.png");
                  } catch (e) {}

                  // Write File
                  window.FS.writeFile("/cart.png", window._cartdat);
                  // console.log(`💾 [Pico8Bridge] Wrote /cart.png to VFS`);

                  // C. The Antidote (Phase 72)
                  if (window._cartdat) {
                    delete window._cartdat;
                  }

                  // D. The Offline Patch (Phase 73)
                  window.lexaloffle_bbs_player = 0;

                  // E. Launch
                  // Safety Check: ensure wrapper is still valid
                  if (window.Module && window.Module.callMain) {
                    // console.log("[Pico8Bridge] Launching Engine...");
                    window.Module.callMain(window.Module.arguments);
                  }

                  clearInterval(poller);
                  haptics.success();
                } catch (e) {
                  // console.error("❌ [Pico8Bridge] VFS Write Failed:", e);
                  haptics.error();
                }
              }
            }
          }, 50); // Fast poll
        },
      ],

      print: (text) => {
        // console.log("[PICO-8]", text);
      },
      printErr: (text) => {
        // console.warn("[PICO-8 Error]", text);
      },
      onRuntimeInitialized: () => {
        // console.log("[Pico8Bridge] Engine Runtime Initialized");
        window.p8_is_running = true;
      },
    };

    // 3. Inject Script
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
    // console.log("[Pico8Bridge] Shutting down...");
    this.isActive = false;
    window.p8_is_running = false;

    // Kill Switch Signal for pico8.js loop
    window.Pico8Kill = true;

    // Attempt clean Engine pause
    try {
      if (window.Module && window.Module.pauseMainLoop) {
        window.Module.pauseMainLoop();
      }
    } catch (e) {}

    // Audio Context Cleanup
    if (window.pico8_audio_context) {
      try {
        window.pico8_audio_context.close();
      } catch (e) {}
      window.pico8_audio_context = null;
    }

    // Kill Script
    const existing = document.getElementById("pico8-engine-script");
    if (existing) existing.remove();

    // Nuke Module
    window.Module = null;
  }

  resumeAudio() {
    // ios safari audio unlock
    const ctx =
      window.pico8_audio_context ||
      (window.Module && window.Module.sdl_audio_context);
    if (ctx && ctx.state === "suspended") {
      ctx.resume().then(() => {
        console.log("[pico8bridge] audio context resumed");
      });
    }
  }

  pause() {
    try {
      if (window.Module && window.Module.pauseMainLoop) {
        window.Module.pauseMainLoop();
      }
      // suspend audio
      const ctx =
        window.pico8_audio_context ||
        (window.Module && window.Module.sdl_audio_context);
      if (ctx && ctx.state === "running") ctx.suspend();
      console.log("wm: [pico8bridge] engine paused");
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
      console.log("wm: [pico8bridge] engine resumed");
    } catch (e) {
      console.warn("wm: resume failed", e);
    }
  }
}

// Singleton Export
export const picoBridge = new Pico8Bridge();

// Global Access (for debugging/console usage)
window.Pico8Bridge = picoBridge;
