import { reactive } from "vue";
import { useLibraryStore } from "../stores/library";

class InputManagerService {
  constructor() {
    this.state = reactive({
      inputMode: "UI", // 'UI' | 'GAME'
      active: false,
    });

    this.listeners = new Set();
    this.loopId = null;
    this.lastButtonState = {};

    // keyboard state
    this.keys = {};
    this.boundKeyHandler = this.handleKey.bind(this);

    // pico-8 layout (left=1, right=2, up=4, down=8, o=16, x=32)
    if (typeof window !== "undefined") {
      window.pico8_buttons = window.pico8_buttons || [0, 0, 0, 0, 0, 0, 0, 0];
    }
  }

  init() {
    if (this.loopId) return;
    this.state.active = true;

    // attach keyboard listeners
    window.addEventListener("keydown", this.boundKeyHandler);
    window.addEventListener("keyup", this.boundKeyHandler);

    this.loop();
    console.log("[input-manager] initialized");
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
    this.keys[e.key] = e.type === "keydown";
  }

  // register a listener for ui events
  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMode(mode) {
    if (!["UI", "GAME"].includes(mode)) return;

    this.state.inputMode = mode;
    console.log(`[input-manager] mode switched to ${mode}`);

    // clear inputs when switching to avoid stuck buttons
    this.lastButtonState = {};

    // reset virtual gamepad bits for pico-8
    if (mode === "UI") {
      if (window.pico8_buttons) window.pico8_buttons[0] = 0;
    }
  }

  loop = () => {
    this.poll();
    this.loopId = requestAnimationFrame(this.loop);
  };

  poll() {
    const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
    const store = useLibraryStore();
    const swapButtons = store.swapButtons;

    // --- raw inputs ---

    // gamepad buttons
    const gpA = gp?.buttons[0]?.pressed || false;
    const gpB = gp?.buttons[1]?.pressed || false;
    const gpX = gp?.buttons[2]?.pressed || false;
    const gpY = gp?.buttons[3]?.pressed || false;
    const gpSelect = gp?.buttons[8]?.pressed || false;
    const gpStart = gp?.buttons[9]?.pressed || false;

    // gamepad d-pad / axes
    const gpUp = gp?.buttons[12]?.pressed || gp?.axes[1] < -0.5 || false;
    const gpDown = gp?.buttons[13]?.pressed || gp?.axes[1] > 0.5 || false;
    const gpLeft = gp?.buttons[14]?.pressed || gp?.axes[0] < -0.5 || false;
    const gpRight = gp?.buttons[15]?.pressed || gp?.axes[0] > 0.5 || false;

    // keyboard nav
    const kbUp = this.checkKeys(["ArrowUp"]);
    const kbDown = this.checkKeys(["ArrowDown"]);
    const kbLeft = this.checkKeys(["ArrowLeft"]);
    const kbRight = this.checkKeys(["ArrowRight"]);

    // --- merged inputs ---

    const up = gpUp || kbUp;
    const down = gpDown || kbDown;
    const left = gpLeft || kbLeft;
    const right = gpRight || kbRight;

    // global system menu (select/start or escape)
    const menuPressed = gpSelect || gpStart || this.checkKeys(["Escape"]);

    if (menuPressed) {
      this.emitOnce("menu");
    } else {
      this.lastButtonState["menu"] = false;
    }

    if (this.state.inputMode === "GAME") {
      this.pollGameMode({
        up,
        down,
        left,
        right,
        gpA,
        gpB,
        gpX,
        gpY,
        swapButtons,
      });
    } else {
      this.pollUIMode({ up, down, left, right, gpA, gpB, swapButtons });
    }
  }

  pollGameMode({ up, down, left, right, gpA, gpB, gpX, gpY, swapButtons }) {
    let bitmask = 0;

    if (left) bitmask |= 1;
    if (right) bitmask |= 2;
    if (up) bitmask |= 4;
    if (down) bitmask |= 8;

    let inputO = false;
    let inputX = false;

    // gamepad
    if (!swapButtons) {
      if (gpA || gpY) inputO = true;
      if (gpB || gpX) inputX = true;
    } else {
      if (gpB || gpX) inputO = true;
      if (gpA || gpY) inputX = true;
    }

    // keyboard (z/c/n=O, x/v/m=X)
    if (this.checkKeys(["z", "Z", "c", "C", "n", "N"])) inputO = true;
    if (this.checkKeys(["x", "X", "v", "V", "m", "M"])) inputX = true;

    if (inputO) bitmask |= 16;
    if (inputX) bitmask |= 32;

    if (window.pico8_buttons) {
      window.pico8_buttons[0] = bitmask;
    }
  }

  pollUIMode({ up, down, left, right, gpA, gpB, swapButtons }) {
    // nav
    this.emitChange("nav-up", up);
    this.emitChange("nav-down", down);
    this.emitChange("nav-left", left);
    this.emitChange("nav-right", right);

    // confirm / back
    let confirm = false;
    let back = false;

    // gamepad
    if (!swapButtons) {
      if (gpA) confirm = true;
      if (gpB) back = true;
    } else {
      if (gpB) confirm = true;
      if (gpA) back = true;
    }

    if (this.checkKeys(["z", "Z", "Enter", " "])) confirm = true;
    if (this.checkKeys(["x", "X", "Backspace", "Escape"])) back = true;

    this.emitChange("confirm", confirm);
    this.emitChange("back", back);
  }

  checkKeys(keyList) {
    return keyList.some((k) => this.keys[k]);
  }

  emitOnce(event) {
    if (!this.lastButtonState[event]) {
      this.emit(event);
      this.lastButtonState[event] = true;
    }
  }

  emitChange(event, isPressed) {
    if (isPressed) {
      this.emitOnce(event);
    } else {
      this.lastButtonState[event] = false;
    }
  }

  emit(eventName, data = null) {
    this.listeners.forEach((listener) => listener(eventName, data));
  }
}

export const inputManager = new InputManagerService();
