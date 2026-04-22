@component
export class SoundEffectsController extends BaseScriptComponent {
    @ui.group_start("Note Creation Sounds")
    @input
    @allowUndefined
    @hint("Played when pressing hand button to start finger dwell note placement.")
    private activateDwellSfx: AudioTrackAsset | undefined;
    @input
    @hint("Volume for activate dwell sound effect.")
    private activateDwellSfxVolume: number = 1.0;
    @input
    @allowUndefined
    @hint("Optional sound when dwell state becomes ready (green).")
    private dwellReadySfx: AudioTrackAsset | undefined;
    @input
    @hint("Volume for dwell-ready sound effect.")
    private dwellReadySfxVolume: number = 1.0;
    @input
    @allowUndefined
    @hint("Optional sound when note spawn is confirmed.")
    private noteSpawnedSfx: AudioTrackAsset | undefined;
    @input
    @hint("Volume for note-spawned sound effect.")
    private noteSpawnedSfxVolume: number = 1.0;
    @ui.group_end

    private activateDwellPlayer: AudioComponent | undefined;
    private dwellReadyPlayer: AudioComponent | undefined;
    private noteSpawnedPlayer: AudioComponent | undefined;

    private onAwake(): void {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    }

    private onStart(): void {
        this.activateDwellPlayer = this.createPlayer(this.activateDwellSfx, this.activateDwellSfxVolume);
        this.dwellReadyPlayer = this.createPlayer(this.dwellReadySfx, this.dwellReadySfxVolume);
        this.noteSpawnedPlayer = this.createPlayer(this.noteSpawnedSfx, this.noteSpawnedSfxVolume);
    }

    public playActivateDwell(): void {
        this.playOneShot(this.activateDwellPlayer);
    }

    public playDwellReady(): void {
        this.playOneShot(this.dwellReadyPlayer);
    }

    public playNoteSpawned(): void {
        this.playOneShot(this.noteSpawnedPlayer);
    }

    private createPlayer(track: AudioTrackAsset | undefined, volume: number): AudioComponent | undefined {
        if (!track) {
            return undefined;
        }

        const player = this.sceneObject.createComponent("AudioComponent");
        player.audioTrack = track;
        player.playbackMode = Audio.PlaybackMode.LowLatency;
        player.volume = Math.max(0, volume);
        return player;
    }

    private playOneShot(player: AudioComponent | undefined): void {
        if (!player) {
            return;
        }

        player.stop(false);
        player.play(1);
    }
}
