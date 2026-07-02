import { InteractableOutlineFeedback } from "SpectaclesInteractionKit.lspkg/Components/Helpers/InteractableOutlineFeedback";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { PinchButton } from "SpectaclesInteractionKit.lspkg/Components/UI/PinchButton/PinchButton";
import { ToggleButton } from "SpectaclesInteractionKit.lspkg/Components/UI/ToggleButton/ToggleButton";
import { Widget } from "../Widget";
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event";
import { INoteData } from "Scripts/INoteData";
import { PinPointNoteSimpleVisibilityToggle } from "Scripts/PinPointNoteSimpleVisibilityToggle";
import { CustomMath } from "Scripts/Utils/CustomMath";
import { LSTween } from "LSTween.lspkg/Examples/Scripts/LSTween";
import Tween from "LSTween.lspkg/TweenJS/Tween";
import Easing from "LSTween.lspkg/TweenJS/Easing";

// SST constants
const DEFAULT_SAMPLE_RATE = 44100;
const ASR_SILENCE_UNTIL_TERMINATION_MS = 1000; // in milliseconds
const MIN_VALID_SAMPLE_RATE = 8000;
const ASR_MODE = AsrModule.AsrMode.HighSpeed;

// Spawn animation constants
const SPAWN_POP_DURATION_SECONDS = 0.22;
const SPAWN_POP_START_SCALE_MULTIPLIER = 0.2;
const SPAWN_ROTATE_BOUNCE_DURATION_SECONDS = 0.75;
const SPAWN_ROTATE_BOUNCE_MAX_ANGLE_DEGREES = 18.0;
const SPAWN_ROTATE_BOUNCE_FREQUENCY_HZ = 2.8;
const SPAWN_ROTATE_BOUNCE_DAMPING = 2.8;
const SPAWN_ROTATE_BOUNCE_PIVOT_LOCAL = new vec3(0, 5, 0);

@component
export class Note extends BaseScriptComponent {
  private readonly onTranscriptionFinalEvent = new Event<void>();
  public readonly onTranscriptionFinal: PublicApi<void> =
    this.onTranscriptionFinalEvent.publicApi();

  private readonly onNoteCompletedEvent = new Event<INoteData>();
  public readonly onNoteCompleted: PublicApi<INoteData> =
    this.onNoteCompletedEvent.publicApi();

  // UI/Visual setup
  @input private _textField: Text;
  @input
  @allowUndefined
  @hint("Optional image component used to show a cropped capture on the note.")
  private _croppedImage: Image | undefined;
  @input private _editToggle: ToggleButton;
  @input @allowUndefined private deleteButton: PinchButton | undefined;
  @input @allowUndefined private noteInteractable: Interactable | undefined;
  @input private noteMesh: RenderMeshVisual;
  @input
  @hint("Outline material that appears when the note is being edited")
  private editOutlineMaterial: Material;
  @input private visibilityToggle: PinPointNoteSimpleVisibilityToggle;

  // Mic recording setup
  @ui.separator
  @ui.group_start("Mic Recording Setup")
  @input
  @hint("Button used to start/stop voice recording")
  private recordButton: PinchButton;
  @input
  @allowUndefined
  @hint("Optional mesh visual whose texture changes while recording.")
  private microphoneButtonMesh: RenderMeshVisual | undefined;
  @input
  @allowUndefined
  @hint("Texture used for microphone button while recording.")
  private microphoneButtonRecordingTexture: Texture | undefined;
  @input
  @allowUndefined
  @hint(
    "Optional idle texture to restore when recording stops. If empty, captures current texture on start.",
  )
  private microphoneButtonIdleTexture: Texture | undefined;
  @input
  @allowUndefined
  @hint("Audio From Microphone track asset")
  private microphoneAsset: AudioTrackAsset | undefined;
  @input
  @allowUndefined
  @hint("Optional text component used to show recording status")
  private voiceStatusText: Text | undefined;

  @input
  @hint("Sample rate used for recording")
  private sampleRate = DEFAULT_SAMPLE_RATE;
  @ui.group_end

  // Camera indicator setup
  @ui.separator
  @ui.group_start("Camera Indicator")
  @input private cameraIndicatorContainer: SceneObject;
  @input private cameraIndicatorImage: Image;
  @input private cameraStatusText: Text;
  @ui.group_end

  // // Audio feedback setup
  // @input private audio: AudioComponent;
  // @input private sfxDeletion: AudioTrackAsset;
  
  private lastHoveredTime: number = -1;
  private timeToShowButtonsAfterHover = 2;
  private outlineFeedback: InteractableOutlineFeedback;

  private widget: Widget;
  private meshMaterial: Material;
  private microphoneControl: MicrophoneAudioProvider | undefined;
  private recordAudioUpdateEvent: UpdateEvent | undefined;
  private numberOfSamples = 0;
  private recordingDuration = 0;
  private isRecording = false;
  private recordingStartedAt = 0;
  private didRetryMicAfterEmptyFrames = false;
  private asrModule: AsrModule | undefined;
  private isAsrRunning = false;
  private effectiveSampleRate = DEFAULT_SAMPLE_RATE;

  // ============================================================
  // [AutoStartSTT] NEW
  // When true, this note begins voice recording + speech-to-text
  // automatically once onStart() finishes wiring up the mic.
  // Set by AreaManager.spawnWidget() for FRESH spawns only (dwell /
  // debug), and left false for restored notes so reloading an area
  // does not start recording on every saved note.
  // The manual record button (pinch) is left fully intact.
  // ============================================================
  public autoStartRecordingOnReady = false;

  // Note's states
  private createdAt: Date;
  private voiceTranscription: string = "";
  private croppedImageTexture?: Texture;
  private croppedImageAISummary?: string;
  private isSpawnPopAnimationActive = false;
  private spawnPopAnimationStartedAt = 0;
  private spawnPopBaseScale = vec3.one();
  private isSpawnRotateBounceActive = false;
  private spawnRotateBounceStartedAt = 0;
  private spawnRotateBounceBaseRotation = quat.quatIdentity();
  private spawnRotateBounceBasePosition = vec3.zero();
  private spawnRotateBounceAnchorTarget = vec3.zero();
  private microphoneButtonMaterial: Material | undefined;
  private resolvedMicrophoneButtonIdleTexture: Texture | undefined;
  private microphoneButtonShowsRecordingTexture = false;
  private readonly microphoneTexturePropertyCandidates = [
    "baseTex",
    "baseTexture",
    "baseColorTex",
    "mainTex",
    "diffuseTex",
    "albedoTex",
  ];
  private microphoneMeshTween: Tween | undefined;
  private cameraMeshTween: Tween | undefined;

  private mergeFinalAndPartial(
    finalizedRaw: string,
    partialRaw: string,
  ): string {
    const finalized = (finalizedRaw || "").trim();
    const partial = (partialRaw || "").trim();
    if (finalized.length === 0) {
      return partial;
    }
    if (partial.length === 0) {
      return finalized;
    }

    // Many ASR implementations return partial text that is cumulative and may already
    // include previously-finalized words. Avoid double-rendering in the UI.
    const finalizedWithSpace = `${finalized} `;
    if (partial.startsWith(finalizedWithSpace)) {
      return partial;
    }
    if (partial === finalized) {
      return finalized;
    }

    // If there's overlap between the end of finalized and the start of partial,
    // only append the non-overlapping suffix.
    const maxOverlap = Math.min(finalized.length, partial.length);
    for (let k = maxOverlap; k > 0; k--) {
      if (finalized.slice(finalized.length - k) === partial.slice(0, k)) {
        const suffix = partial.slice(k).trim();
        return suffix.length > 0 ? `${finalized} ${suffix}` : finalized;
      }
    }

    return `${finalized} ${partial}`;
  }

  /**
   * Final segments may repeat the whole phrase so far (cumulative) or share a
   * word boundary with what we already stored; avoid duplicating in voiceTranscription.
   */
  private appendFinalChunkToTranscript(
    currentRaw: string,
    finalChunkRaw: string,
  ): string {
    const c = (currentRaw || "").trim();
    const t = (finalChunkRaw || "").trim();
    if (t.length === 0) {
      return c;
    }
    if (c.length === 0) {
      return t;
    }
    if (t === c) {
      return c;
    }
    if (
      t.length >= c.length &&
      t.startsWith(c) &&
      (t.length === c.length || t.charAt(c.length) === " ")
    ) {
      return t;
    }
    const maxOverlap = Math.min(c.length, t.length);
    for (let k = maxOverlap; k > 0; k--) {
      if (c.slice(c.length - k) === t.slice(0, k)) {
        const suffix = t.slice(k).trim();
        return suffix.length > 0 ? `${c} ${suffix}`.trim() : c;
      }
    }
    return `${c} ${t}`.trim();
  }

  onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
  }

  private onStart() {
    if (!this.noteMesh || !this.noteMesh.mainMaterial) {
      print(
        "[Note] Missing noteMesh or noteMesh.mainMaterial on " +
          this.sceneObject.name,
      );
      return;
    }

    if (!this._editToggle) {
      print("[Note] Missing edit toggle on " + this.sceneObject.name);
      return;
    }

    this.meshMaterial = this.noteMesh.mainMaterial.clone();
    this.noteMesh.mainMaterial = this.meshMaterial;

    this.initializeMicrophoneButtonVisual();
    this.setCameraIndicatorActiveVisual(true);

    if (this._croppedImage && this._croppedImage.mainMaterial) {
      this._croppedImage.mainMaterial = this._croppedImage.mainMaterial.clone();
      this._croppedImage.getSceneObject().enabled = false;
    }

    this.widget = this.sceneObject.getComponent(Widget.getTypeName());

    if (this.deleteButton && this.deleteButton.onButtonPinched) {
      this.deleteButton.onButtonPinched.add(() => {
        // this.playDeletionFeedback();
        this.stopAllVoiceActivity();
        if (this.widget) {
          this.widget.delete();
        } else {
          // Fallback safety: still remove note if Widget component lookup failed.
          this.sceneObject.destroy();
        }
      });
    }

    if (this.noteInteractable) {
      this.noteInteractable.onHoverUpdate.add(() => {
        this.lastHoveredTime = getTime();
      });
    }

    this.outlineFeedback = this.sceneObject.getComponent(
      InteractableOutlineFeedback.getTypeName(),
    );

    this._editToggle.onStateChanged.add((isToggledOn: boolean) => {
      if (isToggledOn) {
        this.outlineFeedback.enabled = false;
        this.addEditOutline();
      } else {
        this.removeEditOutline();
        this.outlineFeedback.enabled = true;
      }
    });

    this.setupVoiceNoteControls();
    this.createdAt = new Date(Date.now());

    // ============================================================
    // [AutoStartSTT] NEW
    // Kick off recording + speech-to-text automatically for freshly
    // spawned notes. This reuses the exact same code path as the
    // manual mic-button pinch (recordMicrophoneAudio -> mic.start ->
    // startSpeechToText), so:
    //   - the mic "recording" icon + status text update immediately,
    //   - the live transcript still flows into _textField, and
    //   - onNoteCompleted (final transcript) still fires, so the
    //     Snap Cloud / Supabase sync is unchanged.
    // recordMicrophoneAudio() safely no-ops if voice setup was
    // skipped (no mic asset), so this is guard-free here.
    // ============================================================
    if (this.autoStartRecordingOnReady) {
      this.recordMicrophoneAudio(true);
    }
  }

  private onUpdate() {
    this.updateSpawnPopAnimation();
    this.updateSpawnRotateBounceAnimation();

    // ===== [AutoStartSTT] OLD (commented out, kept for reference) =====
    // const shouldShowButtons =
    //     getTime() - this.timeToShowButtonsAfterHover < this.lastHoveredTime;
    // ============================================================
    // [AutoStartSTT] NEW
    // Also keep the controls (mic icon, status text, etc.) visible
    // while actively recording, so an auto-started note clearly shows
    // "mic is on" without the user first having to hover it. Normal
    // hover-to-reveal behaviour is preserved via the original clause.
    // ============================================================
    const shouldShowButtons =
      getTime() - this.timeToShowButtonsAfterHover < this.lastHoveredTime ||
      this.isRecording;
    this._editToggle.getSceneObject().enabled = shouldShowButtons;
    if (this.deleteButton) {
      this.deleteButton.getSceneObject().enabled = shouldShowButtons;
    }

    if (this.recordButton) {
      this.recordButton.getSceneObject().enabled = shouldShowButtons;
    }

    if (this.voiceStatusText) {
      this.voiceStatusText.getSceneObject().enabled = shouldShowButtons;
    }

    if (this.cameraIndicatorContainer) {
      this.cameraIndicatorContainer.enabled = shouldShowButtons;
    }

    if (this.cameraStatusText) {
      this.cameraStatusText.getSceneObject().enabled = shouldShowButtons;
    }

    // Some UI components may re-apply materials every frame; enforce icon state.
    this.updateMicrophoneButtonVisualState();
  }

  public getNoteId(): number {
    return this.createdAt.getUTCSeconds();
  }

  public sendCompleteNoteData() {
    const noteData: INoteData = {
      noteId: this.getNoteId(),
      createdAt: this.createdAt,
      voiceTranscription: this.voiceTranscription,
      croppedImageTexture: this.croppedImageTexture,
      croppedImageAISummary: this.croppedImageAISummary,
    };
    this.onNoteCompletedEvent.invoke(noteData);
  }

  public pushToBackground() {
    this.visibilityToggle.hide();
  }

  public pullToForeground() {
    this.visibilityToggle.show();
  }

  private setupVoiceNoteControls(): void {
    if (!this.microphoneAsset) {
      this.updateVoiceStatusText("Voice setup needs microphone asset");
      print("Voice note setup skipped: microphoneAsset missing.");
      return;
    }

    this.microphoneControl = this.microphoneAsset
      .control as MicrophoneAudioProvider;
    this.effectiveSampleRate = this.resolveSampleRate();
    this.microphoneControl.sampleRate = this.effectiveSampleRate;

    this.recordAudioUpdateEvent = this.createEvent("UpdateEvent");
    this.recordAudioUpdateEvent.bind(() => this.onRecordAudio());
    this.recordAudioUpdateEvent.enabled = false;

    this.recordButton?.onButtonPinched.add(() => {
      this.handleRecordButtonPinched();
    });

    this.updateVoiceStatusText("Press record button");
  }

  private handleRecordButtonPinched(): void {
    const shouldRecord = !this.isRecording;
    // Keep mic icon feedback responsive even if recording startup fails.
    this.microphoneButtonShowsRecordingTexture = shouldRecord;
    this.updateMicrophoneButtonVisualState();
    this.recordMicrophoneAudio(shouldRecord);
  }

  private getAsrModule(): AsrModule | undefined {
    if (this.asrModule) {
      return this.asrModule;
    }

    try {
      this.asrModule = require("LensStudio:AsrModule");
      return this.asrModule;
    } catch (_) {
      this.updateVoiceStatusText("Speech-to-text unavailable on this runtime");
      return undefined;
    }
  }

  private startSpeechToText(): void {
    const asrModule = this.getAsrModule();
    if (!asrModule) {
      return;
    }

    const options = AsrModule.AsrTranscriptionOptions.create();
    options.silenceUntilTerminationMs = ASR_SILENCE_UNTIL_TERMINATION_MS;
    options.mode = ASR_MODE;

    options.onTranscriptionUpdateEvent.add(
      (eventArgs: AsrModule.TranscriptionUpdateEvent) => {
        const transcript = eventArgs.text ? eventArgs.text.trim() : "";
        if (transcript === "") {
          return;
        }

        if (eventArgs.isFinal) {
          // Final chunk — commit to voiceTranscription (the source of truth)
          this.voiceTranscription = this.appendFinalChunkToTranscript(
            this.voiceTranscription,
            transcript,
          );
          this._textField.text = (this.voiceTranscription || "").trim();
          this.onTranscriptionFinalEvent.invoke();
          this.sendCompleteNoteData();
          // mock record button pinched behaviour
          if (this.isRecording) this.handleRecordButtonPinched();
        } else {
          // Partial chunk — show live preview.
          const committed = (this.voiceTranscription || "").trim();

          if (committed.length === 0) {
            // No finalized text yet — partial IS the preview
            this._textField.text = transcript;
          } else if (transcript.startsWith(committed)) {
            // Cumulative partial that extends committed — show it as-is
            this._textField.text = transcript;
          } else {
            // Partial doesn't extend committed (ASR restarted a new phrase after final).
            // Ignore this partial in the UI — keep showing the committed text.
            // If the new phrase becomes final, it'll be appended via appendFinalChunkToTranscript.
            this._textField.text = committed;
          }
        }
      },
    );

    options.onTranscriptionErrorEvent.add(
      (statusCode: AsrModule.AsrStatusCode) => {
        this.updateVoiceStatusText(`Speech-to-text error: ${statusCode}`);
      },
    );

    asrModule.startTranscribing(options);
    this.isAsrRunning = true;
    this.playSSTStartFeedback();
  }

  private stopSpeechToText(): void {
    const asrModule = this.getAsrModule();
    if (!asrModule || !this.isAsrRunning) {
      return;
    }

    asrModule
      .stopTranscribing()
      .catch((_e: unknown) => {
        this.updateVoiceStatusText("Speech-to-text stop failed");
      })
      .then(() => {
        this.isAsrRunning = false;
        return;
      });

    this.playSSTEndFeedback();
  }

  private onRecordAudio(): void {
    if (!this.microphoneControl) {
      return;
    }

    const frameSize = this.microphoneControl.maxFrameSize;
    const rawFrame = new Float32Array(frameSize);
    const audioFrameShape = this.microphoneControl.getAudioFrame(rawFrame);

    if (audioFrameShape.x === 0) {
      if (
        this.isRecording &&
        !this.didRetryMicAfterEmptyFrames &&
        getTime() - this.recordingStartedAt > 1.0
      ) {
        // Some runtimes occasionally start recording without delivering frames.
        // Retry the microphone stream once to recover without user restart.
        this.didRetryMicAfterEmptyFrames = true;
        this.updateVoiceStatusText("Mic active, retrying...");
        this.microphoneControl.stop();
        this.microphoneControl.start();
      }
      return;
    }

    this.numberOfSamples += audioFrameShape.x;
    this.recordingDuration = this.numberOfSamples / this.effectiveSampleRate;

    this.updateVoiceStatusText(
      `Recording ${this.formatSeconds(this.recordingDuration)}s`,
    );
  }

  private recordMicrophoneAudio(shouldRecord: boolean): void {
    if (!this.microphoneControl) {
      return;
    }

    if (!shouldRecord) {
      this.microphoneControl.stop();
      this.stopSpeechToText();
      this.isRecording = false;
      if (this.recordAudioUpdateEvent) {
        this.recordAudioUpdateEvent.enabled = false;
      }

      if (this.recordingDuration > 0) {
        this.updateVoiceStatusText(
          `Recorded ${this.formatSeconds(this.recordingDuration)}s`,
        );
      }
      this.microphoneButtonShowsRecordingTexture = false;
      this.updateMicrophoneButtonVisualState();
      return;
    }

    this.numberOfSamples = 0;
    this.recordingDuration = 0;
    this.voiceTranscription = "";
    this._textField.text = "";
    this.recordingStartedAt = getTime();
    this.didRetryMicAfterEmptyFrames = false;
    this.microphoneControl.start();
    this.startSpeechToText();
    this.isRecording = true;

    if (this.recordAudioUpdateEvent) {
      this.recordAudioUpdateEvent.enabled = true;
    }

    this.updateVoiceStatusText("Recording started");
    this.microphoneButtonShowsRecordingTexture = true;
    this.updateMicrophoneButtonVisualState();
  }

  private stopAllVoiceActivity(): void {
    if (this.isRecording) {
      this.recordMicrophoneAudio(false);
    }
  }

  // private playDeletionFeedback(): void {
  //   if (!this.audio || !this.sfxDeletion) {
  //     return;
  //   }

  //   this.audio.stop(false);
  //   this.audio.audioTrack = this.sfxDeletion;
  //   this.audio.play(1);
  // }

  private updateVoiceStatusText(message: string): void {
    if (!this.voiceStatusText) {
      return;
    }

    this.voiceStatusText.text = message;
  }

  private initializeMicrophoneButtonVisual(): void {
    if (!this.microphoneButtonMesh || !this.microphoneButtonMesh.mainMaterial) {
      return;
    }

    this.microphoneButtonMaterial =
      this.microphoneButtonMesh.mainMaterial.clone();
    this.microphoneButtonMesh.mainMaterial = this.microphoneButtonMaterial;

    this.resolvedMicrophoneButtonIdleTexture =
      this.microphoneButtonIdleTexture ||
      this.getMicrophoneButtonTextureFromPass();

    this.updateMicrophoneButtonVisualState();
  }

  private updateMicrophoneButtonVisualState(): void {
    if (!this.microphoneButtonMesh) {
      return;
    }

    const targetTexture = this.microphoneButtonShowsRecordingTexture
      ? this.microphoneButtonRecordingTexture ||
        this.resolvedMicrophoneButtonIdleTexture
      : this.resolvedMicrophoneButtonIdleTexture;

    if (targetTexture) {
      this.applyMicrophoneButtonTextureToMesh(targetTexture);
    }
  }

  private getMicrophoneButtonTextureFromPass(): Texture | undefined {
    if (!this.microphoneButtonMaterial) {
      return undefined;
    }

    const pass = this.microphoneButtonMaterial.mainPass as unknown as {
      [key: string]: Texture | undefined;
    };
    for (let i = 0; i < this.microphoneTexturePropertyCandidates.length; i++) {
      const propertyName = this.microphoneTexturePropertyCandidates[i];
      const texture = pass[propertyName];
      if (texture) {
        return texture;
      }
    }
    return undefined;
  }

  private setMicrophoneButtonTextureOnPass(texture: Texture): void {
    if (!this.microphoneButtonMaterial) {
      return;
    }

    const pass = this.microphoneButtonMaterial.mainPass as unknown as {
      [key: string]: Texture | undefined;
    };
    let updatedAnyProperty = false;

    for (let i = 0; i < this.microphoneTexturePropertyCandidates.length; i++) {
      const propertyName = this.microphoneTexturePropertyCandidates[i];
      if (pass[propertyName] !== undefined) {
        pass[propertyName] = texture;
        updatedAnyProperty = true;
      }
    }

    // Fallback for dynamic material passes where texture fields are not enumerable.
    if (!updatedAnyProperty) {
      pass.baseTex = texture;
      pass.baseTexture = texture;
    }
  }

  private applyMicrophoneButtonTextureToMesh(texture: Texture): void {
    if (!this.microphoneButtonMesh) {
      return;
    }

    // Keep using the cloned material if available.
    this.setMicrophoneButtonTextureOnPass(texture);

    // Also patch all current materials on the mesh because UI/Button scripts
    // can swap materials at runtime and override the cloned reference.
    const matCount = this.microphoneButtonMesh.getMaterialsCount();
    for (let i = 0; i < matCount; i++) {
      const mat = this.microphoneButtonMesh.getMaterial(i);
      if (!mat) {
        continue;
      }
      this.setTextureOnMaterialPass(mat, texture);
    }

    if (this.microphoneButtonMesh.mainMaterial) {
      this.setTextureOnMaterialPass(
        this.microphoneButtonMesh.mainMaterial,
        texture,
      );
    }
  }

  private setTextureOnMaterialPass(material: Material, texture: Texture): void {
    const pass = material.mainPass as unknown as {
      [key: string]: Texture | undefined;
    };
    let updatedAnyProperty = false;

    for (let i = 0; i < this.microphoneTexturePropertyCandidates.length; i++) {
      const propertyName = this.microphoneTexturePropertyCandidates[i];
      if (pass[propertyName] !== undefined) {
        pass[propertyName] = texture;
        updatedAnyProperty = true;
      }
    }

    if (!updatedAnyProperty) {
      pass.baseTex = texture;
      pass.baseTexture = texture;
    }
  }

  private resolveSampleRate(): number {
    if (isFinite(this.sampleRate) && this.sampleRate >= MIN_VALID_SAMPLE_RATE) {
      return this.sampleRate;
    }

    print(
      `[Note] Invalid sampleRate (${this.sampleRate}) on ${this.sceneObject.name}. Falling back to ${DEFAULT_SAMPLE_RATE}.`,
    );
    return DEFAULT_SAMPLE_RATE;
  }

  private formatSeconds(value: number): string {
    if (!isFinite(value) || value < 0) {
      return "0.0";
    }
    return value.toFixed(1);
  }

  public setCroppedImage(image: Texture) {
    if (!this._croppedImage || !this._croppedImage.mainMaterial) {
      print(
        "[Note] Cropped image target is not assigned on " +
          this.sceneObject.name,
      );
      return;
    }

    this._croppedImage.getSceneObject().enabled = true;
    this._croppedImage.mainMaterial.mainPass.baseTex = image;
    this.croppedImageTexture = image;
  }

  public setCroppedImageAISummary(summary: string) {
    // TODO: will we display the AI summary on Note UI?
    this.croppedImageAISummary = summary;
  }

  /**
   * Set the editing state of the voice note
   * @param isEditing - the editing state
   */
  public toggleEditButton(isEditing: boolean): void {
    if (this._editToggle.isToggledOn === isEditing) {
      return;
    }

    this._editToggle.toggle();
  }

  public get textField(): Text {
    return this._textField;
  }

  public set textField(textField: Text) {
    this._textField = textField;
  }

  public get editToggle(): ToggleButton {
    return this._editToggle;
  }

  public set editToggle(editToggle: ToggleButton) {
    this._editToggle = editToggle;
  }

  public playSpawnPopAnimation(): void {
    const transform = this.sceneObject.getTransform();
    this.spawnPopBaseScale = transform.getLocalScale();
    this.spawnRotateBounceBasePosition = transform.getLocalPosition();
    this.spawnRotateBounceBaseRotation = transform.getLocalRotation();
    this.spawnRotateBounceAnchorTarget = this.spawnRotateBounceBasePosition.add(
      this.spawnRotateBounceBaseRotation.multiplyVec3(
        SPAWN_ROTATE_BOUNCE_PIVOT_LOCAL,
      ),
    );
    this.spawnPopAnimationStartedAt = getTime();
    this.spawnRotateBounceStartedAt = this.spawnPopAnimationStartedAt;
    this.isSpawnPopAnimationActive = true;
    this.isSpawnRotateBounceActive = true;

    transform.setLocalScale(
      CustomMath.multiplyScale(
        this.spawnPopBaseScale,
        SPAWN_POP_START_SCALE_MULTIPLIER,
      ),
    );
  }

  private updateSpawnPopAnimation(): void {
    if (!this.isSpawnPopAnimationActive) {
      return;
    }

    const elapsed = getTime() - this.spawnPopAnimationStartedAt;
    const duration = SPAWN_POP_DURATION_SECONDS;
    const normalized = Math.max(0, Math.min(1, elapsed / duration));
    const eased = CustomMath.easeInOutCubic(normalized);
    const scaleMultiplier = CustomMath.lerp(
      SPAWN_POP_START_SCALE_MULTIPLIER,
      1,
      eased,
    );

    this.sceneObject
      .getTransform()
      .setLocalScale(
        CustomMath.multiplyScale(this.spawnPopBaseScale, scaleMultiplier),
      );

    if (normalized >= 1) {
      this.isSpawnPopAnimationActive = false;
      this.sceneObject.getTransform().setLocalScale(this.spawnPopBaseScale);
    }
  }

  private updateSpawnRotateBounceAnimation(): void {
    if (!this.isSpawnRotateBounceActive) {
      return;
    }

    const elapsed = getTime() - this.spawnRotateBounceStartedAt;
    const duration = SPAWN_ROTATE_BOUNCE_DURATION_SECONDS;
    const normalized = Math.max(0, Math.min(1, elapsed / duration));

    const decay = Math.exp(-SPAWN_ROTATE_BOUNCE_DAMPING * normalized);
    const oscillation = Math.sin(
      elapsed * SPAWN_ROTATE_BOUNCE_FREQUENCY_HZ * Math.PI * 2,
    );
    const angleDegrees =
      SPAWN_ROTATE_BOUNCE_MAX_ANGLE_DEGREES * decay * oscillation;
    const swingRotation = quat.angleAxis(
      angleDegrees * (Math.PI / 180),
      vec3.forward(),
    );
    const currentRotation =
      this.spawnRotateBounceBaseRotation.multiply(swingRotation);
    const pivotWorldFromCurrent = currentRotation.multiplyVec3(
      SPAWN_ROTATE_BOUNCE_PIVOT_LOCAL,
    );
    const correctedPosition = this.spawnRotateBounceAnchorTarget.sub(
      pivotWorldFromCurrent,
    );

    this.sceneObject.getTransform().setLocalRotation(currentRotation);
    this.sceneObject.getTransform().setLocalPosition(correctedPosition);

    if (normalized >= 1) {
      this.isSpawnRotateBounceActive = false;
      this.sceneObject
        .getTransform()
        .setLocalRotation(this.spawnRotateBounceBaseRotation);
      this.sceneObject
        .getTransform()
        .setLocalPosition(this.spawnRotateBounceBasePosition);
    }
  }

  private addEditOutline(): void {
    const matCount = this.noteMesh.getMaterialsCount();

    let addMaterial = true;
    for (let k = 0; k < matCount; k++) {
      const material = this.noteMesh.getMaterial(k);

      if (material.isSame(this.editOutlineMaterial)) {
        addMaterial = false;
        break;
      }
    }

    if (addMaterial) {
      const materials = this.noteMesh.materials;
      materials.unshift(this.editOutlineMaterial);
      this.noteMesh.materials = materials;
    }
  }

  private removeEditOutline(): void {
    const materials = [];

    const matCount = this.noteMesh.getMaterialsCount();

    for (let k = 0; k < matCount; k++) {
      const material = this.noteMesh.getMaterial(k);

      if (material.isSame(this.editOutlineMaterial)) {
        continue;
      }

      materials.push(material);
    }

    this.noteMesh.clearMaterials();

    for (let k = 0; k < materials.length; k++) {
      this.noteMesh.addMaterial(materials[k]);
    }
  }

  public playCameraCaptureStartFeedback(): void {
    this.setCameraIndicatorActiveVisual(true);

    // Play camera indicator breathing animation feedback
    const cameraIndicatorTransform =
      this.cameraIndicatorContainer.getTransform();
    const cameraIndicatorOriginalScale =
      cameraIndicatorTransform.getLocalScale().x;
    this.cameraMeshTween = LSTween.scaleFromToLocal(
      cameraIndicatorTransform,
      vec3.one().uniformScale(cameraIndicatorOriginalScale * 0.8),
      vec3.one().uniformScale(cameraIndicatorOriginalScale * 1.2),
      1000,
    )
      .easing(Easing.Quadratic.Out)
      .yoyo(true)
      .repeat(Infinity)
      .delay(100)
      .start();

    this.cameraStatusText.text = "Camera on ...";
  }

  public playCameraCaptureEndFeedback(): void {
    if (this.cameraMeshTween?.isPlaying()) this.cameraMeshTween.stop();

    this.setCameraIndicatorActiveVisual(false);
    this.cameraStatusText.text = "Camera off.";
  }

  private setCameraIndicatorActiveVisual(isActive: boolean): void {
    const mainMat = this.cameraIndicatorImage.mainMaterial;
    if(isActive) {
      mainMat.mainPass.baseColor = vec4.one();
    } else {
      mainMat.mainPass.baseColor = vec4.zero();
    }
  }

  private playSSTStartFeedback(): void {
    const microphoneTransform = this.microphoneButtonMesh
      ?.getSceneObject()
      .getTransform();
    const microphoneOriginalScale = microphoneTransform.getLocalScale().x;
    this.microphoneMeshTween = LSTween.scaleFromToLocal(
      microphoneTransform,
      vec3.one().uniformScale(microphoneOriginalScale * 0.8),
      vec3.one().uniformScale(microphoneOriginalScale * 1.2),
      1000,
    )
      .easing(Easing.Quadratic.Out)
      .yoyo(true)
      .repeat(Infinity)
      .delay(100)
      .start();
  }

  private playSSTEndFeedback(): void {
    if (this.microphoneMeshTween?.isPlaying()) this.microphoneMeshTween.stop();
  }
}
