import { reactive, watch } from "vue";
import { useLibraryStore } from "../stores/library";
import { Capacitor } from "@capacitor/core";

class InputManagerService {
  constructor() {
    this.state = reactive({
      inputMode: "UI", // 'UI' | 'GAME'
      active: false,
    });

    this.listeners = new Set();
    this.loopId = null;
    this.lastButtonState = {
      menu: false,
      navUp: null,
      navDown: null,
      navLeft: null,
      navRight: null,
      confirm: false,
      back: false,
      start: false,
    };

    // STATIC BUFFERS
    // store frame inputs
    this._inputBuffer = {
      up: false,
      down: false,
      left: false,
      right: false,
      a: false,
      b: false,
      x: false,
      y: false,
      start: false,
      select: false,
    };

    // cached store values to avoid allocation in poll
    this.swapButtons = false;
    this.isAndroid = Capacitor.getPlatform() === "android";
    this._justSwapped = false;

    // keyboard state
    this.keys = {};
    this.boundKeyHandler = this.handleKey.bind(this);

    // pico-8 layout default (left=1, right=2, up=4, down=8, o=16, x=32)
    if (typeof window !== "undefined") {
      window.pico8_buttons = window.pico8_buttons || [0, 0, 0, 0, 0, 0, 0, 0];
    }
  }

  init() {
    if (this.loopId) return;
    this.state.active = true;

    // sync initial settings & watch for changes
    const store = useLibraryStore();
    this.swapButtons = store.swapButtons;

    // watch store for swap changes (avoids polling store in loop)
    watch(
      () => store.swapButtons,
      (newVal) => {
        const oldVal = this.swapButtons;
        this.swapButtons = newVal;
        console.log(`[input-manager] cached swapButtons updated: ${newVal}`);

        if (this.state.inputMode === "UI" && newVal !== oldVal) {
          this.lastButtonState["back"] = true;
          this.lastButtonState["confirm"] = true;
          this._justSwapped = true;
        }
      },
      { flush: "sync" }
    );

    // attach keyboard listeners
    window.addEventListener("keydown", this.boundKeyHandler);
    window.addEventListener("keyup", this.boundKeyHandler);

    this.loop();
    console.log("[input-manager] initialized (zero-latency mode)");
  }

  destroy() {
    if (this.loopId) {
      cancelAnimationFrame(this.loopId);
      this.loopId = null;
    }
    window.removeEventListener("keydown", this.boundKeyHandler);
    window.removeEventListener("keyup", this.boundKeyHandler);
    this.state.active = false;
  }

  handleKey(e) {
    // ignore synth events
    if (!e.isTrusted) return;

    this.keys[e.key] = e.type === "keydown";

    if (this.state.inputMode === "UI" && e.type === "keydown") {
      const isInput =
        document.activeElement &&
        (document.activeElement.tagName === "INPUT" ||
          document.activeElement.tagName === "TEXTAREA");

      // prevent escape
      if (e.code === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }

      if (e.code === "Backspace" && !isInput) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }

      if (e.code === "Space" && !isInput) {
        e.preventDefault();
      }
    }
  }

  setVirtualKey(keyCode, pressed) {
    const map = {
      37: "ArrowLeft",
      38: "ArrowUp",
      39: "ArrowRight",
      40: "ArrowDown",
      88: "x",
      90: "z",
      13: "Enter",
    };

    const key = map[keyCode];
    if (key) {
      this.keys[key] = pressed;
    }
  }

  // register a listener for ui events
  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMode(mode) {
    if (!["UI", "GAME"].includes(mode)) return;

    this.state.inputMode = mode;

    // clear inputs when switching to avoid stuck buttons
    this.lastButtonState = {
      menu: false,
      navUp: null, // object when active
      navDown: null,
      navLeft: null,
      navRight: null,
      confirm: false,
      back: false,
      wiggle: false,
    };

    // reset virtual gamepad bits
    if (mode === "UI") {
      if (window.pico8_buttons) window.pico8_buttons[0] = 0;
    }
  }

  loop = () => {
    // reset protect flag at start of new frame
    this._justSwapped = false;

    // force input flush on android
    if (this.isAndroid) {
      this.poll();
    }
    this.poll();
    this.loopId = requestAnimationFrame(this.loop);
  };

  poll() {
    const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;

    // gather raw inputs into buffer
    const buf = this._inputBuffer;

    if (gp) {
      // gamepad
      const btns = gp.buttons;
      const axes = gp.axes;

      buf.a = btns[0]?.pressed || false;
      buf.b = btns[1]?.pressed || false;
      buf.x = btns[2]?.pressed || false; // usually unused
      buf.y = btns[3]?.pressed || false; // usually unused
      buf.select = btns[8]?.pressed || false;
      buf.start = btns[9]?.pressed || false;

      // dpad / analog hybrid
      buf.up = btns[12]?.pressed || axes[1] < -0.5 || false;
      buf.down = btns[13]?.pressed || axes[1] > 0.5 || false;
      buf.left = btns[14]?.pressed || axes[0] < -0.5 || false;
      buf.right = btns[15]?.pressed || axes[0] > 0.5 || false;
    } else {
      // reset if no gamepad
      buf.a = false;
      buf.b = false;
      buf.x = false;
      buf.y = false;
      buf.select = false;
      buf.start = false;
      buf.up = false;
      buf.down = false;
      buf.left = false;
      buf.right = false;
    }

    // kb
    if (this.keys["ArrowUp"]) buf.up = true;
    if (this.keys["ArrowDown"]) buf.down = true;
    if (this.keys["ArrowLeft"]) buf.left = true;
    if (this.keys["ArrowRight"]) buf.right = true;

    // GAME MODE
    if (this.state.inputMode === "GAME") {
      let mask = 0;

      if (buf.left) mask |= 1;
      if (buf.right) mask |= 2;
      if (buf.up) mask |= 4;
      if (buf.down) mask |= 8;

      let o = false;
      let x = false;

      // map face buttons
      if (!this.swapButtons) {
        if (buf.a || buf.y) o = true;
        if (buf.b || buf.x) x = true;
        // keys
        if (
          this.keys["z"] ||
          this.keys["Z"] ||
          this.keys["c"] ||
          this.keys["C"] ||
          this.keys["n"] ||
          this.keys["N"]
        )
          o = true;
        if (
          this.keys["x"] ||
          this.keys["X"] ||
          this.keys["v"] ||
          this.keys["V"] ||
          this.keys["m"] ||
          this.keys["M"]
        )
          x = true;
      } else {
        if (buf.b || buf.x) o = true;
        if (buf.a || buf.y) x = true;
        // keys
        if (
          this.keys["x"] ||
          this.keys["X"] ||
          this.keys["v"] ||
          this.keys["V"] ||
          this.keys["m"] ||
          this.keys["M"]
        )
          o = true;
        if (
          this.keys["z"] ||
          this.keys["Z"] ||
          this.keys["c"] ||
          this.keys["C"] ||
          this.keys["n"] ||
          this.keys["N"]
        )
          x = true;
      }

      if (o) mask |= 16;
      if (x) mask |= 32;

      // handle pause/menu
      if (buf.select || this.keys["Escape"]) {
        this.emitOnce("menu");
      } else {
        this.lastButtonState["menu"] = false;
      }

      if (buf.start || this.keys["Enter"] || this.keys["p"] || this.keys["P"]) {
        if (!this.lastButtonState["start"]) {
          this.lastButtonState["start"] = true;
          this.dispatchKey(80, "keydown");
        }
      } else {
        if (this.lastButtonState["start"]) {
          this.lastButtonState["start"] = false;
          this.dispatchKey(80, "keyup");
        }
      }

      // DIRECT INJECTION
      if (window.pico8_buttons) {
        window.pico8_buttons[0] = mask;
      }
    }
    // UI MODE
    else {
      // nav
      const isTyping = document.activeElement?.tagName === "INPUT";

      this.handleNavInput("nav-up", buf.up);
      this.handleNavInput("nav-down", buf.down);

      if (!isTyping) {
        this.handleNavInput("nav-left", buf.left);
        this.handleNavInput("nav-right", buf.right);
      }

      // confirm / back
      let confirm = false;
      let back = false;

      // gamepad face
      if (!this.swapButtons) {
        if (buf.a) confirm = true;
        if (buf.b) back = true;
      } else {
        if (buf.b) confirm = true;
        if (buf.a) back = true;
      }

      // keyboard
      if (
        this.keys["z"] ||
        this.keys["Z"] ||
        this.keys["Enter"] ||
        this.keys[" "]
      )
        confirm = true;
      if (this.keys["x"] || this.keys["X"] || this.keys["Escape"]) back = true;

      this.emitChange("confirm", confirm);
      this.emitChange("back", back);

      // edit mode
      let wiggle = false;
      if (buf.y) wiggle = true;
      if (this.keys["e"] || this.keys["E"]) wiggle = true;
      this.emitChange("wiggle", wiggle);
    }
  }

  // handle navigation with key repeat
  // delay: 400ms, rate: 100ms
  handleNavInput(event, isPressed) {
    const now = Date.now();
    const state = this.lastButtonState[event];

    if (isPressed) {
      if (!state) {
        // first press
        this.emit(event);
        this.lastButtonState[event] = {
          pressed: true,
          startTime: now,
          lastRepeat: now,
        };
      } else if (state.pressed) {
        // holding
        const elapsed = now - state.startTime;
        if (elapsed > 400) {
          // initial delay
          if (now - state.lastRepeat > 100) {
            // repeat rate
            this.emit(event);
            state.lastRepeat = now;
          }
        }
      }
    } else {
      // released
      if (state) {
        this.lastButtonState[event] = null;
      }
    }
  }

  emitOnce(event) {
    if (!this.lastButtonState[event]) {
      this.emit(event);
      this.lastButtonState[event] = true;
    }
  }

  emitChange(event, isPressed) {
    if (isPressed) {
      if (!this.lastButtonState[event]) {
        this.emit(event);
        this.lastButtonState[event] = true;
      }
    } else {
      // protect against clearing state if we just swapped buttons in this frame
      if (this._justSwapped && (event === "back" || event === "confirm")) {
        return;
      }
      this.lastButtonState[event] = false;
    }
  }

  emit(eventName, data = null) {
    this.listeners.forEach((listener) => listener(eventName, data));
  }

  dispatchKey(keyCode, type) {
    const keyMap = { 13: "Enter", 80: "p" };
    const codeMap = { 13: "Enter", 80: "KeyP" };

    const key = keyMap[keyCode] || "";
    const code = codeMap[keyCode] || "";

    const event = new KeyboardEvent(type, {
      key: key,
      code: code,
      bubbles: true,
      cancelable: true,
      view: window,
    });

    // emscripten: define property for read-only fields
    Object.defineProperty(event, "keyCode", { get: () => keyCode });
    Object.defineProperty(event, "which", { get: () => keyCode });
    Object.defineProperty(event, "charCode", { get: () => keyCode });

    const target = document.getElementById("canvas") || document;
    target.dispatchEvent(event);
  }

  // legacy compat
  checkKeys(keyList) {
    return false;
  }
}

export const inputManager = new InputManagerService();
