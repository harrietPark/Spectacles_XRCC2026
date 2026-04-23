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

      this._textField.text = transcript

      // Invoke transcription end event if it is final
      if (eventArgs.isFinal) {
        print("--- transcription final: " + eventArgs.text);
        this.voiceTranscription += eventArgs.text;
        this.onTranscriptionFinalEvent.invoke();

        // TODO: send complete note data when user looks away from the note
        this.sendCompleteNoteData();
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
