import { Env, TranscriptionOptions, TranscriptionResult, TTSOptions, AudioFormat, AudioContentType } from '../types';
import { createClient } from '@deepgram/sdk';

/**
 * Determines the content type based on file format
 * @param format Audio format
 * @returns Content type string
 */
export function getContentType(format: AudioFormat): AudioContentType {
	switch (format) {
		case 'wav':
			return 'audio/wav';
		case 'mp3':
			return 'audio/mpeg';
		case 'flac':
			return 'audio/flac';
		case 'ogg':
			return 'audio/ogg';
		case 'webm':
			return 'audio/webm';
		default:
			return 'audio/wav';
	}
}

/**
 * Validates that the request contains valid audio data
 * @param request Request containing audio data
 * @returns Validation result with audio buffer if valid
 */
export async function validateAudioInput(request: Request): Promise<{
	valid: boolean;
	audioBuffer?: ArrayBuffer;
	contentType?: AudioContentType;
	error?: string;
}> {
	try {
		const contentType = request.headers.get('Content-Type');

		if (!contentType || !contentType.includes('audio/')) {
			return {
				valid: false,
				error: 'Invalid content type. Expected audio file.',
			};
		}

		let validContentType: AudioContentType | undefined;
		if (contentType.includes('audio/wav') || contentType.includes('audio/x-wav')) {
			validContentType = 'audio/wav';
		} else if (contentType.includes('audio/mpeg')) {
			validContentType = 'audio/mpeg';
		} else if (contentType.includes('audio/flac')) {
			validContentType = 'audio/flac';
		} else if (contentType.includes('audio/ogg')) {
			validContentType = 'audio/ogg';
		} else if (contentType.includes('audio/webm')) {
			validContentType = 'audio/webm';
		} else {
			return {
				valid: false,
				error: `Unsupported audio format: ${contentType}. Supported formats: wav, mp3, flac, ogg, webm.`,
			};
		}

		const audioBuffer = await request.arrayBuffer();

		if (!audioBuffer || audioBuffer.byteLength === 0) {
			return {
				valid: false,
				error: 'Empty audio file received.',
			};
		}

		// check file size (limit to 100MB — Cloudflare Workers hard limit)
		if (audioBuffer.byteLength > 100 * 1024 * 1024) {
			return {
				valid: false,
				error: 'Audio file too large. Maximum size is 100MB.',
			};
		}

		return {
			valid: true,
			audioBuffer,
			contentType: validContentType,
		};
	} catch (error: any) {
		return {
			valid: false,
			error: `Error processing audio: ${error.message}`,
		};
	}
}

/**
 * Transcribes audio data to text using Deepgram's API
 * @param audioBuffer Audio data to transcribe
 * @param env Environment variables containing API keys
 * @param options Transcription options
 * @returns Transcription result with text and metadata
 */
export async function transcribeAudio(
	audioBuffer: ArrayBuffer,
	env: Env,
	options: TranscriptionOptions = {}
): Promise<TranscriptionResult> {
	try {
		// Set up default options
		const defaultOptions: Required<TranscriptionOptions> = {
			model: 'nova-3',
			language: 'en',
			detectLanguage: false,
			languages: [],
			smartFormat: true,
			diarize: false,
			punctuate: true,
			sampleRate: '16000',
		};

		const mergedOptions = { ...defaultOptions, ...options };

		if (mergedOptions.languages && mergedOptions.languages.length > 0) {
			mergedOptions.detectLanguage = mergedOptions.languages.length > 1;
			mergedOptions.language = mergedOptions.languages[0];
		}

		const deepgramClient = createClient(env.DEEPGRAM_API_KEY);

		const buffer = Buffer.from(audioBuffer);

		const transcriptionOptions = {
			model: mergedOptions.model,
			smart_format: mergedOptions.smartFormat,
			diarize: mergedOptions.diarize,
			language: mergedOptions.language,
			detect_language: mergedOptions.detectLanguage,
			punctuate: mergedOptions.punctuate,
			sample_rate: mergedOptions.sampleRate,
		};

		console.log(`Transcribing audio with model ${mergedOptions.model}, language: ${mergedOptions.language}`);

		const { result, error } = await deepgramClient.listen.prerecorded.transcribeFile(buffer, transcriptionOptions);

		if (error) {
			throw new Error(`Deepgram transcription error: ${error.message}`);
		}

		const transcription = result?.results?.channels[0]?.alternatives[0]?.transcript || '';
		const confidence = result?.results?.channels[0]?.alternatives[0]?.confidence || 0;
		const words = result?.results?.channels[0]?.alternatives[0]?.words || [];
		const detectedLanguage = result?.results?.channels[0]?.detected_language;

		return {
			text: transcription,
			confidence,
			language: detectedLanguage,
			words,
		};
	} catch (error: any) {
		console.error('Transcription error:', error);
		return {
			text: '',
			confidence: 0,
			error: error.message,
		};
	}
}

/**
 * Converts text to speech using Deepgram's REST API
 * @param text Text to convert to speech
 * @param env Environment variables containing API keys
 * @param options Text-to-speech options
 * @returns Audio buffer of the synthesized speech or null if error
 */
export async function textToSpeech(text: string, env: Env, options: TTSOptions = {}): Promise<ArrayBuffer | null> {
	try {
		if (!text || text.trim() === '') {
			throw new Error('Empty text provided for text-to-speech conversion');
		}

		const voice = options.voice || 'aura-asteria-en';
		const encoding = options.encoding || 'linear16';

		console.log(`Converting text to speech using voice: ${voice}, encoding: ${encoding}`);
		console.log(`Text length: ${text.length} characters`);

		const url = new URL('https://api.deepgram.com/v1/speak');
		url.searchParams.set('model', voice);

		if (encoding !== 'linear16') {
			url.searchParams.set('encoding', encoding);
		}

		const response = await fetch(url.toString(), {
			method: 'POST',
			headers: {
				Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ text }),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`TTS API error ${response.status}: ${errorText}`);
			throw new Error(`Deepgram TTS error: ${errorText}`);
		}

		const audioBuffer = await response.arrayBuffer();
		console.log(`Received audio response: ${audioBuffer.byteLength} bytes`);

		return audioBuffer;
	} catch (error: any) {
		console.error('Error in text-to-speech:', error);
		return null;
	}
}
