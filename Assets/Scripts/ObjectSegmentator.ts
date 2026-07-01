/** 
 * Segments objects in the view and plays real-world anchored feedback when objects are segmented.
 */

import { setTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils";

@component
export class ObjectSegmentator extends BaseScriptComponent {
    private onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private onStart() {}

    private onUpdate() {}

    public async segmentObjectsInView(): Promise<void> {
        // send camera view to cloud AI
        // get object segmentation results from cloud AI
        // anchor visual feedback to objects
        // delete the visual feedback after a delay
        await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 2000);
        });
    }

    public anchorVisualFeedbackToObjects() {}
}
