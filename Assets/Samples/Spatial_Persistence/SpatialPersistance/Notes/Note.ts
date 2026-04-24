import {InteractableOutlineFeedback} from "SpectaclesInteractionKit.lspkg/Components/Helpers/InteractableOutlineFeedback"
import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {PinchButton} from "SpectaclesInteractionKit.lspkg/Components/UI/PinchButton/PinchButton"
import {ToggleButton} from "SpectaclesInteractionKit.lspkg/Components/UI/ToggleButton/ToggleButton"
import {Widget} from "../Widget"
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { INoteData } from "Scripts/INoteData"

type AudioFrameData = {
  audioFrame: Float32Array
  audioFrameShape: vec3
}

const DEFAULT_SAMPLE_RATE = 44100
// const ASR_SILENCE_UNTIL_TERMINATION_MS = 10000 // in milliseconds
const ASR_SILENCE_UNTIL_TERMINATION_MS = 1000 // in milliseconds
const MIN_VALID_SAMPLE_RATE = 8000

@component
export class Note extends BaseScriptComponent {
  private static readonly SPAWN_POP_DURATION_SECONDS = 0.22
  private static readonly SPAWN_POP_START_SCALE_MULTIPLIER = 0.2
  private static readonly SPAWN_ROTATE_BOUNCE_DURATION_SECONDS = 0.75
  private static readonly SPAWN_ROTATE_BOUNCE_MAX_ANGLE_DEGREES = 18.0
  private static readonly SPAWN_ROTATE_BOUNCE_FREQUENCY_HZ = 2.8
  private static readonly SPAWN_ROTATE_BOUNCE_DAMPING = 2.8
  private static readonly SPAWN_ROTATE_BOUNCE_PIVOT_LOCAL = new vec3(0, 5, 0)

  private readonly onTranscriptionFinalEvent = new Event<void>();
  public readonly onTranscriptionFinal: PublicApi<void> = this.onTranscriptionFinalEvent.publicApi();

  private readonly onNoteCompletedEvent = new Event<INoteData>();
  public readonly onNoteCompleted: PublicApi<INoteData> = this.onNoteCompletedEvent.publicApi();

  @input private _textField: Text
  @input
  @allowUndefined
  @hint("Optional image component used to show a cropped capture on the note.")
  private _croppedImage: Image | undefined
  @input private _editToggle: ToggleButton
  @input @allowUndefined private deleteButton: PinchButton | undefined
  @input @allowUndefined private noteInteractable: Interactable | undefined
  @input private noteMesh: RenderMeshVisual
  @input
  @hint("Outline material that appears when the note is being edited")
  private editOutlineMaterial: Material

  @input
  @allowUndefined
  @hint("Optional button used to start/stop voice recording")
  private recordButton: PinchButton | undefined

  @input
  @allowUndefined
  @hint("Optional button used to playback the recorded voice note")
  private playbackButton: PinchButton | undefined

  @input
  @allowUndefined
  @hint("Audio From Microphone track asset")
  private microphoneAsset: AudioTrackAsset | undefined

  @input
  @allowUndefined
  @hint("Audio Output track asset used for playback")
  private audioOutputAsset: AudioTrackAsset | undefined

  @input
  @allowUndefined
  @hint("Optional text component used to show record/playback status")
  private voiceStatusText: Text | undefined

  @input
  @hint("Sample rate used for recording and playback")
  private sampleRate = DEFAULT_SAMPLE_RATE

  private lastHoveredTime: number = -1
  private timeToShowButtonsAfterHover = 2
  private outlineFeedback: InteractableOutlineFeedback

  private widget: Widget
  private meshMaterial: Material
  private audioComponent: AudioComponent | undefined
  private microphoneControl: MicrophoneAudioProvider | undefined
  private audioOutputProvider: AudioOutputProvider | undefined
  private recordAudioUpdateEvent: UpdateEvent | undefined
  private playbackAudioUpdateEvent: UpdateEvent | undefined
  private recordedAudioFrames: AudioFrameData[] = []
  private numberOfSamples = 0
  private recordingDuration = 0
  private currentPlaybackTime = 0
  private playbackSafetyTimeout = 0
  private isRecording = false
  private isPlayingBack = false
  private asrModule: AsrModule | undefined
  private isAsrRunning = false
  private effectiveSampleRate = DEFAULT_SAMPLE_RATE

  // Note's states
  private createdAt: Date;
  private voiceTranscription: string = "";
  private croppedImageTexture?: Texture;
  private croppedImageAISummary?: string;
  private isSpawnPopAnimationActive = false
  private spawnPopAnimationStartedAt = 0
  private spawnPopBaseScale = vec3.one()
  private isSpawnRotateBounceActive = false
  private spawnRotateBounceStartedAt = 0
  private spawnRotateBounceBaseRotation = quat.quatIdentity()
  private spawnRotateBounceBasePosition = vec3.zero()
  private spawnRotateBounceAnchorTarget = vec3.zero()

  private mergeFinalAndPartial(finalizedRaw: string, partialRaw: string): string {
    const finalized = (finalizedRaw || "").trim()
    const partial = (partialRaw || "").trim()
    if (finalized.length === 0) {
      return partial
    }
    if (partial.length === 0) {
      return finalized
    }

    // Many ASR implementations return partial text that is cumulative and may already
    // include previously-finalized words. Avoid double-rendering in the UI.
    const finalizedWithSpace = `${finalized} `
    if (partial.startsWith(finalizedWithSpace)) {
      return partial
    }
    if (partial === finalized) {
      return finalized
    }

    // If there's overlap between the end of finalized and the start of partial,
    // only append the non-overlapping suffix.
    const maxOverlap = Math.min(finalized.length, partial.length)
    for (let k = maxOverlap; k > 0; k--) {
      if (finalized.slice(finalized.length - k) === partial.slice(0, k)) {
        const suffix = partial.slice(k).trim()
        return suffix.length > 0 ? `${finalized} ${suffix}` : finalized
      }
    }

    return `${finalized} ${partial}`
  }

  /**
   * Final segments may repeat the whole phrase so far (cumulative) or share a
   * word boundary with what we already stored; avoid duplicating in voiceTranscription.
   */
  private appendFinalChunkToTranscript(currentRaw: string, finalChunkRaw: string): string {
    const c = (currentRaw || "").trim()
    const t = (finalChunkRaw || "").trim()
    if (t.length === 0) {
      return c
    }
    if (c.length === 0) {
      return t
    }
    if (t === c) {
      return c
    }
    if (t.length >= c.length && t.startsWith(c) && (t.length === c.length || t.charAt(c.length) === " ")) {
      return t
    }
    const maxOverlap = Math.min(c.length, t.length)
    for (let k = maxOverlap; k > 0; k--) {
      if (c.slice(c.length - k) === t.slice(0, k)) {
        const suffix = t.slice(k).trim()
        return suffix.length > 0 ? `${c} ${suffix}`.trim() : c
      }
    }
    return `${c} ${t}`.trim()
  }

  onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this))
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
  }

  private onStart() {
    if (!this.noteMesh || !this.noteMesh.mainMaterial) {
      print("[Note] Missing noteMesh or noteMesh.mainMaterial on " + this.sceneObject.name)
      return
    }

    if (!this._editToggle) {
      print("[Note] Missing edit toggle on " + this.sceneObject.name)
      return
    }

    this.meshMaterial = this.noteMesh.mainMaterial.clone()
    this.noteMesh.mainMaterial = this.meshMaterial

    if (this._croppedImage && this._croppedImage.mainMaterial) {
      this._croppedImage.mainMaterial = this._croppedImage.mainMaterial.clone()
      this._croppedImage.getSceneObject().enabled = false
    }

    this.widget = this.sceneObject.getComponent(Widget.getTypeName())

    if (this.deleteButton && this.deleteButton.onButtonPinched) {
      this.deleteButton.onButtonPinched.add(() => {
        this.recordMicrophoneAudio(false)
        if (this.widget) {
          this.widget.delete()
        } else {
          // Fallback safety: still remove note if Widget component lookup failed.
          this.sceneObject.destroy()
        }
      })
    }

    if (this.noteInteractable) {
      this.noteInteractable.onHoverUpdate.add(() => {
        this.lastHoveredTime = getTime()
      })
    }

    this.outlineFeedback = this.sceneObject.getComponent(InteractableOutlineFeedback.getTypeName())

    this._editToggle.onStateChanged.add((isToggledOn: boolean) => {
      if (isToggledOn) {
        this.outlineFeedback.enabled = false
        this.addEditOutline()
      } else {
        this.removeEditOutline()
        this.outlineFeedback.enabled = true
      }
    })

    this.setupVoiceNoteControls()
    this.createdAt = new Date(Date.now());
  }

  private onUpdate() {
    this.updateSpawnPopAnimation()
    this.updateSpawnRotateBounceAnimation()

    const shouldShowButtons = getTime() - this.timeToShowButtonsAfterHover < this.lastHoveredTime
    this._editToggle.getSceneObject().enabled = shouldShowButtons
    if (this.deleteButton) {
      this.deleteButton.getSceneObject().enabled = shouldShowButtons
    }

    if (this.recordButton) {
      this.recordButton.getSceneObject().enabled = shouldShowButtons
    }

    if (this.playbackButton) {
      this.playbackButton.getSceneObject().enabled = shouldShowButtons
    }

    if (this.voiceStatusText) {
      this.voiceStatusText.getSceneObject().enabled = shouldShowButtons
    }
  }

  public sendCompleteNoteData() {
    const noteData: INoteData = {
      noteId: this.createdAt.getUTCSeconds(),
      createdAt: this.createdAt,
      voiceTranscription: this.voiceTranscription,
      croppedImageTexture: this.croppedImageTexture,
      croppedImageAISummary: this.croppedImageAISummary
    }
    this.onNoteCompletedEvent.invoke(noteData);
  }

  private setupVoiceNoteControls(): void {
    if (!this.recordButton && !this.playbackButton) {
      return
    }

    if (!this.microphoneAsset || !this.audioOutputAsset) {
      this.updateVoiceStatusText("Voice setup needs microphone and output assets")
      print("Voice note setup skipped: microphoneAsset or audioOutputAsset missing.")
      return
    }

    this.microphoneControl = this.microphoneAsset.control as MicrophoneAudioProvider
    this.effectiveSampleRate = this.resolveSampleRate()
    this.microphoneControl.sampleRate = this.effectiveSampleRate

    this.audioComponent = this.sceneObject.createComponent("AudioComponent")
    this.audioComponent.audioTrack = this.audioOutputAsset
    this.audioComponent.playbackMode = Audio.PlaybackMode.LowLatency

    this.audioOutputProvider = this.audioOutputAsset.control as AudioOutputProvider
    this.audioOutputProvider.sampleRate = this.effectiveSampleRate

    this.recordAudioUpdateEvent = this.createEvent("UpdateEvent")
    this.recordAudioUpdateEvent.bind(() => this.onRecordAudio())
    this.recordAudioUpdateEvent.enabled = false

    this.playbackAudioUpdateEvent = this.createEvent("UpdateEvent")
    this.playbackAudioUpdateEvent.bind(() => this.onPlaybackAudio())
    this.playbackAudioUpdateEvent.enabled = false

    this.recordButton?.onButtonPinched.add(() => {
      this.recordMicrophoneAudio(!this.isRecording)
    })

    this.playbackButton?.onButtonPinched.add(() => {
      this.playbackRecordedAudio()
    })

    this.updateVoiceStatusText("Press record button")
  }

  private getAsrModule(): AsrModule | undefined {
    if (this.asrModule) {
      return this.asrModule
    }

    try {
      this.asrModule = require("LensStudio:AsrModule")
      return this.asrModule
    } catch (_) {
      this.updateVoiceStatusText("Speech-to-text unavailable on this runtime")
      return undefined
    }
  }

  private startSpeechToText(): void {
    const asrModule = this.getAsrModule()
    if (!asrModule) {
      return
    }

    const options = AsrModule.AsrTranscriptionOptions.create()
    options.silenceUntilTerminationMs = ASR_SILENCE_UNTIL_TERMINATION_MS
    // options.mode = AsrModule.AsrMode.HighAccuracy
    options.mode = AsrModule.AsrMode.HighSpeed
    
    options.onTranscriptionUpdateEvent.add((eventArgs: AsrModule.TranscriptionUpdateEvent) => {
      const transcript = eventArgs.text ? eventArgs.text.trim() : ""
      if (transcript === "") {
        return
      }

      if (eventArgs.isFinal) {
        // Final chunk — commit to voiceTranscription (the source of truth)
        print("--- transcription final: " + eventArgs.text);
        this.voiceTranscription = this.appendFinalChunkToTranscript(this.voiceTranscription, transcript)
        this._textField.text = (this.voiceTranscription || "").trim()
        this.onTranscriptionFinalEvent.invoke();
        this.sendCompleteNoteData();
      } else {
        // Partial chunk — show live preview.
        const committed = (this.voiceTranscription || "").trim()

        if (committed.length === 0) {
          // No finalized text yet — partial IS the preview
          this._textField.text = transcript
        } else if (transcript.startsWith(committed)) {
          // Cumulative partial that extends committed — show it as-is
          this._textField.text = transcript
        } else {
          // Partial doesn't extend committed (ASR restarted a new phrase after final).
          // Ignore this partial in the UI — keep showing the committed text.
          // If the new phrase becomes final, it'll be appended via appendFinalChunkToTranscript.
          this._textField.text = committed
        }
      }
    })

    options.onTranscriptionErrorEvent.add((statusCode: AsrModule.AsrStatusCode) => {
      this.updateVoiceStatusText(`Speech-to-text error: ${statusCode}`)
    })

    asrModule.startTranscribing(options)
    this.isAsrRunning = true
  }

  private stopSpeechToText(): void {
    const asrModule = this.getAsrModule()
    if (!asrModule || !this.isAsrRunning) {
      return
    }

    asrModule
      .stopTranscribing()
      .catch((_e: unknown) => {
        this.updateVoiceStatusText("Speech-to-text stop failed")
      })
      .then(() => {
        this.isAsrRunning = false
      })
  }

  private onRecordAudio(): void {
    if (!this.microphoneControl) {
      return
    }

    const frameSize = this.microphoneControl.maxFrameSize
    const rawFrame = new Float32Array(frameSize)
    const audioFrameShape = this.microphoneControl.getAudioFrame(rawFrame)

    if (audioFrameShape.x === 0) {
      return
    }

    const frameData = new Float32Array(rawFrame.subarray(0, audioFrameShape.x))
    this.numberOfSamples += audioFrameShape.x
    this.recordingDuration = this.numberOfSamples / this.effectiveSampleRate

    this.recordedAudioFrames.push({
      audioFrame: frameData,
      audioFrameShape: audioFrameShape
    })

    this.updateVoiceStatusText(`Recording ${this.formatSeconds(this.recordingDuration)}s`)
  }

  private onPlaybackAudio(): void {
    if (!this.isPlayingBack) {
      if (this.playbackAudioUpdateEvent) {
        this.playbackAudioUpdateEvent.enabled = false
      }
      return
    }

    this.currentPlaybackTime += getDeltaTime()
    this.currentPlaybackTime = Math.min(this.currentPlaybackTime, this.recordingDuration)

    this.updateVoiceStatusText(
      `Playback ${this.formatSeconds(this.currentPlaybackTime)}s / ${this.formatSeconds(this.recordingDuration)}s`
    )

    if (this.currentPlaybackTime >= this.recordingDuration || this.currentPlaybackTime >= this.playbackSafetyTimeout) {
      this.stopPlayback("Playback complete")
    }
  }

  private recordMicrophoneAudio(shouldRecord: boolean): void {
    if (!this.microphoneControl) {
      return
    }

    if (!shouldRecord) {
      this.microphoneControl.stop()
      this.stopSpeechToText()
      this.isRecording = false
      if (this.recordAudioUpdateEvent) {
        this.recordAudioUpdateEvent.enabled = false
      }

      if (this.recordingDuration > 0) {
        this.updateVoiceStatusText(`Recorded ${this.formatSeconds(this.recordingDuration)}s`)
      }
      return
    }

    this.recordedAudioFrames = []
    this.numberOfSamples = 0
    this.recordingDuration = 0
    this.currentPlaybackTime = 0
    this.voiceTranscription = ""
    this._textField.text = ""
    this.isPlayingBack = false
    this.audioComponent?.stop(false)
    this.microphoneControl.start()
    this.startSpeechToText()
    this.isRecording = true

    if (this.recordAudioUpdateEvent) {
      this.recordAudioUpdateEvent.enabled = true
    }

    if (this.playbackAudioUpdateEvent) {
      this.playbackAudioUpdateEvent.enabled = false
    }

    this.updateVoiceStatusText("Recording started")
  }

  private playbackRecordedAudio(): void {
    if (!this.audioOutputProvider || !this.audioComponent) {
      return
    }

    if (this.isPlayingBack) {
      this.stopPlayback("Playback stopped")
      return
    }

    if (this.isRecording) {
      this.recordMicrophoneAudio(false)
      this.updateVoiceStatusText("Recording stopped, starting playback")
    }

    if (this.recordedAudioFrames.length === 0) {
      this.updateVoiceStatusText("No recording yet")
      return
    }

    if (!isFinite(this.recordingDuration) || this.recordingDuration <= 0) {
      this.recordingDuration = this.numberOfSamples / this.effectiveSampleRate
    }
    if (!isFinite(this.recordingDuration) || this.recordingDuration <= 0) {
      this.updateVoiceStatusText("Playback unavailable: invalid recording")
      return
    }

    this.currentPlaybackTime = 0
    this.playbackSafetyTimeout = Math.max(this.recordingDuration + 0.5, 0.5)
    ;(this.audioOutputProvider as unknown as {clearAudioFrames?: () => void}).clearAudioFrames?.()
    this.audioComponent.stop(false)
    this.audioComponent.play(1)
    this.isPlayingBack = true

    for (let i = 0; i < this.recordedAudioFrames.length; i++) {
      this.audioOutputProvider.enqueueAudioFrame(
        this.recordedAudioFrames[i].audioFrame,
        this.recordedAudioFrames[i].audioFrameShape
      )
    }

    if (this.playbackAudioUpdateEvent) {
      this.playbackAudioUpdateEvent.enabled = true
    }

    this.updateVoiceStatusText(
      `Playback ${this.formatSeconds(this.currentPlaybackTime)}s / ${this.formatSeconds(this.recordingDuration)}s`
    )
  }

  private stopPlayback(statusMessage: string): void {
    this.audioComponent?.stop(false)
    ;(this.audioOutputProvider as unknown as {clearAudioFrames?: () => void}).clearAudioFrames?.()
    this.isPlayingBack = false
    this.currentPlaybackTime = 0
    this.playbackSafetyTimeout = 0

    if (this.playbackAudioUpdateEvent) {
      this.playbackAudioUpdateEvent.enabled = false
    }

    this.updateVoiceStatusText(statusMessage)
  }

  private updateVoiceStatusText(message: string): void {
    if (!this.voiceStatusText) {
      return
    }

    this.voiceStatusText.text = message
  }

  private resolveSampleRate(): number {
    if (isFinite(this.sampleRate) && this.sampleRate >= MIN_VALID_SAMPLE_RATE) {
      return this.sampleRate
    }

    print(
      `[Note] Invalid sampleRate (${this.sampleRate}) on ${this.sceneObject.name}. Falling back to ${DEFAULT_SAMPLE_RATE}.`
    )
    return DEFAULT_SAMPLE_RATE
  }

  private formatSeconds(value: number): string {
    if (!isFinite(value) || value < 0) {
      return "0.0"
    }
    return value.toFixed(1)
  }

  public setCroppedImage(image: Texture) {
    if (!this._croppedImage || !this._croppedImage.mainMaterial) {
      print("[Note] Cropped image target is not assigned on " + this.sceneObject.name)
      return
    }

    this._croppedImage.getSceneObject().enabled = true
    this._croppedImage.mainMaterial.mainPass.baseTex = image
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
      return
    }

    this._editToggle.toggle()
  }

  public get textField(): Text {
    return this._textField
  }

  public set textField(textField: Text) {
    this._textField = textField
  }

  public get editToggle(): ToggleButton {
    return this._editToggle
  }

  public set editToggle(editToggle: ToggleButton) {
    this._editToggle = editToggle
  }

  public playSpawnPopAnimation(): void {
    const transform = this.sceneObject.getTransform()
    this.spawnPopBaseScale = transform.getLocalScale()
    this.spawnRotateBounceBasePosition = transform.getLocalPosition()
    this.spawnRotateBounceBaseRotation = transform.getLocalRotation()
    this.spawnRotateBounceAnchorTarget = this.spawnRotateBounceBasePosition.add(
      this.spawnRotateBounceBaseRotation.multiplyVec3(Note.SPAWN_ROTATE_BOUNCE_PIVOT_LOCAL)
    )
    this.spawnPopAnimationStartedAt = getTime()
    this.spawnRotateBounceStartedAt = this.spawnPopAnimationStartedAt
    this.isSpawnPopAnimationActive = true
    this.isSpawnRotateBounceActive = true

    transform.setLocalScale(
      this.multiplyScale(
        this.spawnPopBaseScale,
        Note.SPAWN_POP_START_SCALE_MULTIPLIER
      )
    )
  }

  private updateSpawnPopAnimation(): void {
    if (!this.isSpawnPopAnimationActive) {
      return
    }

    const elapsed = getTime() - this.spawnPopAnimationStartedAt
    const duration = Note.SPAWN_POP_DURATION_SECONDS
    const normalized = Math.max(0, Math.min(1, elapsed / duration))
    const eased = this.easeInOutCubic(normalized)
    const scaleMultiplier = this.lerp(Note.SPAWN_POP_START_SCALE_MULTIPLIER, 1, eased)

    this.sceneObject
      .getTransform()
      .setLocalScale(this.multiplyScale(this.spawnPopBaseScale, scaleMultiplier))

    if (normalized >= 1) {
      this.isSpawnPopAnimationActive = false
      this.sceneObject.getTransform().setLocalScale(this.spawnPopBaseScale)
    }
  }

  private updateSpawnRotateBounceAnimation(): void {
    if (!this.isSpawnRotateBounceActive) {
      return
    }

    const elapsed = getTime() - this.spawnRotateBounceStartedAt
    const duration = Note.SPAWN_ROTATE_BOUNCE_DURATION_SECONDS
    const normalized = Math.max(0, Math.min(1, elapsed / duration))

    const decay = Math.exp(-Note.SPAWN_ROTATE_BOUNCE_DAMPING * normalized)
    const oscillation = Math.sin(elapsed * Note.SPAWN_ROTATE_BOUNCE_FREQUENCY_HZ * Math.PI * 2)
    const angleDegrees = Note.SPAWN_ROTATE_BOUNCE_MAX_ANGLE_DEGREES * decay * oscillation
    const swingRotation = quat.angleAxis(angleDegrees * (Math.PI / 180), vec3.forward())
    const currentRotation = this.spawnRotateBounceBaseRotation.multiply(swingRotation)
    const pivotWorldFromCurrent = currentRotation.multiplyVec3(Note.SPAWN_ROTATE_BOUNCE_PIVOT_LOCAL)
    const correctedPosition = this.spawnRotateBounceAnchorTarget.sub(pivotWorldFromCurrent)

    this.sceneObject
      .getTransform()
      .setLocalRotation(currentRotation)
    this.sceneObject
      .getTransform()
      .setLocalPosition(correctedPosition)

    if (normalized >= 1) {
      this.isSpawnRotateBounceActive = false
      this.sceneObject.getTransform().setLocalRotation(this.spawnRotateBounceBaseRotation)
      this.sceneObject.getTransform().setLocalPosition(this.spawnRotateBounceBasePosition)
    }
  }

  private multiplyScale(baseScale: vec3, multiplier: number): vec3 {
    return new vec3(
      baseScale.x * multiplier,
      baseScale.y * multiplier,
      baseScale.z * multiplier
    )
  }

  private lerp(start: number, end: number, t: number): number {
    return start + (end - start) * t
  }

  private easeInOutCubic(t: number): number {
    if (t < 0.5) {
      return 4 * t * t * t
    }
    const p = -2 * t + 2
    return 1 - (p * p * p) / 2
  }

  private addEditOutline(): void {
    const matCount = this.noteMesh.getMaterialsCount()

    let addMaterial = true
    for (let k = 0; k < matCount; k++) {
      const material = this.noteMesh.getMaterial(k)

      if (material.isSame(this.editOutlineMaterial)) {
        addMaterial = false
        break
      }
    }

    if (addMaterial) {
      const materials = this.noteMesh.materials
      materials.unshift(this.editOutlineMaterial)
      this.noteMesh.materials = materials
    }
  }

  private removeEditOutline(): void {
    const materials = []

    const matCount = this.noteMesh.getMaterialsCount()

    for (let k = 0; k < matCount; k++) {
      const material = this.noteMesh.getMaterial(k)

      if (material.isSame(this.editOutlineMaterial)) {
        continue
      }

      materials.push(material)
    }

    this.noteMesh.clearMaterials()

    for (let k = 0; k < materials.length; k++) {
      this.noteMesh.addMaterial(materials[k])
    }
  }
}
