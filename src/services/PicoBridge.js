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
    // Required by game.js schema
    window.pico8_gpio = new Array(128);
    window.p8_is_running = false;
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

      // Phase 72: Force VFS Path, bypass persistent arguments
      arguments: ["-run", "/cart.png"],

      // Phase 72: Race Condition Fix
      noInitialRun: true,

      preRun: [
        function () {
          console.log("[Pico8Bridge] preRun: Starting VFS Poller...");

          const poller = setInterval(() => {
            if (window.FS) {
              // console.log("⚡️ [Pico8Bridge] Global FS Detected!");

              // A. Mount IDBFS (Save Data)
              try {
                window.FS.mkdir("/pico-8");
                window.FS.mount(window.Module.IDBFS, {}, "/pico-8");
                window.FS.syncfs(true, (err) => {
                  // if (!err) console.log("✅ [Pico8Bridge] Save System Mounted");
                });
              } catch (e) {} // Likely already mounted

              // B. Inject Cartridge (Phase 68)
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
    // iOS Safari Audio Unlock
    const ctx =
      window.pico8_audio_context ||
      (window.Module && window.Module.sdl_audio_context);
    if (ctx && ctx.state === "suspended") {
      ctx.resume().then(() => {
        console.log("[Pico8Bridge] Audio Context Resumed");
      });
    }
  }
}

// Singleton Export
export const picoBridge = new Pico8Bridge();

// Global Access (for debugging/console usage)
window.Pico8Bridge = picoBridge;
