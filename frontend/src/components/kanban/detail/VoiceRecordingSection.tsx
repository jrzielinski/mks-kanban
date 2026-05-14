import { useRef, useCallback } from 'react';

export function useVoiceRecognition() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async (
    setTranscript: (val: string) => void,
    setIsRecording: (val: boolean) => void,
    setVoiceReady: (val: boolean) => void,
    boardId: string,
  ) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        try {
          const response = await fetch(`/api/boards/${boardId}/transcribe`, { method: 'POST', body: formData });
          if (!response.ok) throw new Error('Transcription failed');
          const data = await response.json();
          setTranscript(data.transcript || data.text || '');
          setIsRecording(false);
          setVoiceReady(true);
        } catch {
          setIsRecording(false);
        }

        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      // Permission denied or unavailable
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  return { startRecording, stopRecording };
}
