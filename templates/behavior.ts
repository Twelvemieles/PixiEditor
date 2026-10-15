import { Component, isEditorPaused } from "__COMPONENTS__";

/**
 * __NAME__ — behavior for "__OBJECT__", created with Pixi Editor.
 *
 * `this.target` is the object this behavior is attached to and `this.params` holds its settings.
 * It is attached in code with: addComponent(object, __NAME__)
 */
export class __NAME__ extends Component {
  static readonly componentName = "__NAME__";
  static readonly defaults = {};

  /** Called once, when the behavior is attached to the object. */
  attach(): void {
    // Example: make the object clickable
    // this.target.eventMode = "static";
    // this.target.on("pointertap", () => console.log("clicked"));
  }

  /** Called every frame. */
  update(): void {
    if (isEditorPaused()) return; // stay still while Pixi Editor is in Edit mode
    // Example: this.target.rotation += 0.01;
  }

  /** Called when the behavior is removed. */
  detach(): void {}
}
