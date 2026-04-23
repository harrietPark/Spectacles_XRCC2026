export interface INoteData {
    noteId: number;
    createdAt: Date;
    voiceTranscription: string;
    croppedImageTexture?: Texture;
    croppedImageAISummary?: string;
}
