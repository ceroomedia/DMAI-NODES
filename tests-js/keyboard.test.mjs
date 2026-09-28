import test from "node:test";
import assert from "node:assert/strict";
import { containKeyboardEvents } from "../web/dom.mjs";

test("panel and dialog keyboard events stop before canvas shortcuts without cancelling native controls", () => {
  const root = new EventTarget();
  containKeyboardEvents(root);
  for (const type of ["keydown", "keyup"]) {
    let reachedLocalHandler = false;
    const local = (event) => {
      reachedLocalHandler = true;
      assert.equal(event.cancelBubble, true);
      assert.equal(event.defaultPrevented, false);
    };
    root.addEventListener(type, local);
    const event = new Event(type, { bubbles: true, cancelable: true });
    assert.equal(
      root.dispatchEvent(event),
      true,
      "native default behavior must remain enabled",
    );
    assert.equal(
      reachedLocalHandler,
      true,
      "local accessibility and control handlers must still run",
    );
    root.removeEventListener(type, local);
  }
});
test("keyboard containment does not intercept pointer events needed for sockets and dragging", () => {
  const root = new EventTarget();
  containKeyboardEvents(root);
  root.addEventListener("pointerdown", (event) => {
    assert.equal(event.cancelBubble, false);
    assert.equal(event.defaultPrevented, false);
  });
  assert.equal(
    root.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    ),
    true,
  );
});
