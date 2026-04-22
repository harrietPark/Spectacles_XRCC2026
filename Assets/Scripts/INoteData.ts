export interface INoteData {
    noteId: number;
    createdAt: Date;
    voiceTranscription?: string;
    croppedImage?: Texture;
    croppedImageAISummary?: string;
}
