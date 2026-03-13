import { Env } from '../types';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { createSuccessResponse, createErrorResponse } from '../utils/cors';
import { VertexAIProvider } from '../providers/vertex';

/**
 * Handles audio file transcription requests
 * Supports Deepgram (default), Google Speech-to-Text v1, and Chirp 2 (v2 API)
 * @param request The HTTP request containing audio data
 * @param env Environment variables
 * @returns Response with transcription results
 */
export async function handleFileTranscription(request: Request, env: Env): Promise<Response> {
  const provider = request.headers.get('x-transcription-provider')?.toLowerCase() || 'deepgram';

  if (provider === 'chirp2' || provider === 'chirp-2') {
    return handleChirp2Transcription(request, env);
  }

  if (provider === 'google' || provider === 'chirp') {
    return handleGoogleTranscription(request, env);
  }

  return handleDeepgramTranscription(request, env);
}

/**
 * Handles transcription using Deepgram Nova-3
 */
async function handleDeepgramTranscription(request: Request, env: Env): Promise<Response> {
  try {
    const audioBuffer = await request.arrayBuffer();
    const languages = request.headers.get('detect_language')?.split(',') || [];
    const sampleRate = request.headers.get('sample_rate') || '16000';

    // Forward the original Content-Type (e.g. audio/mpeg for MP3, audio/wav for WAV)
    const incomingContentType = request.headers.get('Content-Type') || 'audio/wav';

    const deepgramResponse = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&sample_rate=' +
        sampleRate +
        (languages.length > 0 ? '&' + languages.map((lang) => `detect_language=${lang}`).join('&') : ''),
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          'Content-Type': incomingContentType,
        },
        body: audioBuffer,
      }
    );

    if (!deepgramResponse.ok) {
      const errorData = await deepgramResponse.json();
      throw new Error(`Deepgram API error: ${JSON.stringify(errorData)}`);
    }

    const data: string | object = await deepgramResponse.json();
    return createSuccessResponse(data);
  } catch (error: any) {
    console.error('Error in Deepgram request:', error);
    return createErrorResponse(500, error.message);
  }
}

/**
 * Handles transcription using Google Speech-to-Text v1 API with latest_long model
 * For Chirp 2 (v2 API), use x-transcription-provider: chirp2
 */
async function handleGoogleTranscription(request: Request, env: Env): Promise<Response> {
  try {
    const audioBuffer = await request.arrayBuffer();
    const languages = request.headers.get('detect_language')?.split(',') || ['en-US'];
    const sampleRate = parseInt(request.headers.get('sample_rate') || '16000', 10);

    // Get access token using Vertex AI credentials
    const vertexProvider = new VertexAIProvider(
      env.VERTEX_SERVICE_ACCOUNT_JSON,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_REGION
    );
    const accessToken = await vertexProvider.getAccessToken();

    // Convert audio to base64 (chunked to avoid stack overflow)
    const uint8Array = new Uint8Array(audioBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    const audioBase64 = btoa(binary);

    // Map language codes to Google format (e.g., 'en' -> 'en-US')
    const languageCodes = languages.map(lang => {
      if (lang.includes('-')) return lang;
      // Common mappings
      const mappings: Record<string, string> = {
        'en': 'en-US', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE',
        'it': 'it-IT', 'pt': 'pt-BR', 'ja': 'ja-JP', 'ko': 'ko-KR',
        'zh': 'zh-CN', 'ru': 'ru-RU', 'ar': 'ar-SA', 'hi': 'hi-IN',
      };
      return mappings[lang] || `${lang}-${lang.toUpperCase()}`;
    });

    // Use Speech-to-Text v1 API
    // Note: Chirp 2 requires v2 API which needs separate enablement
    // Using 'latest_long' - Google's best v1 model for long-form audio
    const url = `https://speech.googleapis.com/v1/speech:recognize`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          languageCode: languageCodes[0] || 'en-US',
          model: 'latest_long',
          enableAutomaticPunctuation: true,
          enableWordTimeOffsets: true,
          useEnhanced: true, // Use enhanced model for better accuracy
        },
        audio: {
          content: audioBase64,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Google Speech-to-Text error:', response.status, response.statusText, errorData);
      throw new Error(`Google Speech-to-Text API error (${response.status}): ${errorData || response.statusText}`);
    }

    const data = await response.json() as {
      results?: Array<{
        alternatives?: Array<{
          transcript?: string;
          confidence?: number;
          words?: Array<{
            word?: string;
            startOffset?: string;
            endOffset?: string;
          }>;
        }>;
        languageCode?: string;
      }>;
    };

    // Transform to Deepgram-compatible format for easy integration
    const transcript = data.results?.map(r => r.alternatives?.[0]?.transcript || '').join(' ') || '';
    const confidence = data.results?.[0]?.alternatives?.[0]?.confidence || 0;
    const detectedLanguage = data.results?.[0]?.languageCode || languageCodes[0];

    const deepgramFormat = {
      results: {
        channels: [{
          alternatives: [{
            transcript,
            confidence,
            words: data.results?.flatMap(r =>
              r.alternatives?.[0]?.words?.map(w => ({
                word: w.word || '',
                start: parseFloat(w.startOffset?.replace('s', '') || '0'),
                end: parseFloat(w.endOffset?.replace('s', '') || '0'),
                confidence: confidence,
              })) || []
            ) || [],
          }],
        }],
        metadata: {
          model_info: { name: 'chirp_2' },
          detected_language: detectedLanguage,
        },
      },
    };

    return createSuccessResponse(deepgramFormat);
  } catch (error: any) {
    console.error('Error in Google Speech-to-Text request:', error);
    return createErrorResponse(500, error.message);
  }
}

/**
 * Handles transcription using Google Speech-to-Text v2 API with Chirp 2 model
 * Chirp 2 is Google's SOTA speech recognition model (GA in us-central1, europe-west4, asia-southeast1)
 */
async function handleChirp2Transcription(request: Request, env: Env): Promise<Response> {
  try {
    const audioBuffer = await request.arrayBuffer();
    const languages = request.headers.get('detect_language')?.split(',') || ['en-US'];

    // Get access token using Vertex AI credentials
    const vertexProvider = new VertexAIProvider(
      env.VERTEX_SERVICE_ACCOUNT_JSON,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_REGION
    );
    const accessToken = await vertexProvider.getAccessToken();

    // Convert audio to base64 (chunked to avoid stack overflow)
    const uint8Array = new Uint8Array(audioBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    const audioBase64 = btoa(binary);

    // Map language codes to Google format (e.g., 'en' -> 'en-US')
    const languageCodes = languages.map(lang => {
      if (lang.includes('-')) return lang;
      const mappings: Record<string, string> = {
        'en': 'en-US', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE',
        'it': 'it-IT', 'pt': 'pt-BR', 'ja': 'ja-JP', 'ko': 'ko-KR',
        'zh': 'zh-CN', 'ru': 'ru-RU', 'ar': 'ar-SA', 'hi': 'hi-IN',
      };
      return mappings[lang] || `${lang}-${lang.toUpperCase()}`;
    });

    // Chirp 2 is available in: us-central1, europe-west4, asia-southeast1
    // Use us-central1 as default for best coverage
    const chirp2Region = 'us-central1';
    const projectId = env.VERTEX_PROJECT_ID;

    // Speech-to-Text v2 API endpoint for Chirp 2
    const url = `https://speech.googleapis.com/v2/projects/${projectId}/locations/${chirp2Region}/recognizers/_:recognize`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          auto_decoding_config: {},
          language_codes: languageCodes,
          model: 'chirp_2',
          features: {
            enable_automatic_punctuation: true,
            enable_word_time_offsets: true,
          },
        },
        content: audioBase64,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Chirp 2 error:', response.status, response.statusText, errorData);
      throw new Error(`Chirp 2 API error (${response.status}): ${errorData || response.statusText}`);
    }

    const data = await response.json() as {
      results?: Array<{
        alternatives?: Array<{
          transcript?: string;
          confidence?: number;
          words?: Array<{
            word?: string;
            startOffset?: string;
            endOffset?: string;
          }>;
        }>;
        languageCode?: string;
      }>;
    };

    // Transform to Deepgram-compatible format for easy integration
    const transcript = data.results?.map(r => r.alternatives?.[0]?.transcript || '').join(' ') || '';
    const confidence = data.results?.[0]?.alternatives?.[0]?.confidence || 0;
    const detectedLanguage = data.results?.[0]?.languageCode || languageCodes[0];

    const deepgramFormat = {
      results: {
        channels: [{
          alternatives: [{
            transcript,
            confidence,
            words: data.results?.flatMap(r =>
              r.alternatives?.[0]?.words?.map(w => ({
                word: w.word || '',
                start: parseFloat(w.startOffset?.replace('s', '') || '0'),
                end: parseFloat(w.endOffset?.replace('s', '') || '0'),
                confidence: confidence,
              })) || []
            ) || [],
          }],
        }],
        metadata: {
          model_info: { name: 'chirp_2' },
          detected_language: detectedLanguage,
        },
      },
    };

    return createSuccessResponse(deepgramFormat);
  } catch (error: any) {
    console.error('Error in Chirp 2 request:', error);
    return createErrorResponse(500, error.message);
  }
}

/**
 * Handles WebSocket upgrade for real-time transcription
 * @param request The HTTP request for WebSocket upgrade
 * @param env Environment variables
 * @returns Response with WebSocket connection
 */
export async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response> {
  try {
    const requestId = crypto.randomUUID();

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    let params = new URL(request.url).searchParams;
    let url = new URL('wss://api.deepgram.com/v1/listen');
    
    for (let [key, value] of params.entries()) {
      url.searchParams.set(key, value);
    }

    let deepgram = createClient(env.DEEPGRAM_API_KEY);
    let deepgramSocket = deepgram.listen.live({}, url.toString());

    deepgramSocket.on(LiveTranscriptionEvents.Open, () => {
      server.send(
        JSON.stringify({
          type: 'connected',
          message: 'WebSocket connection established',
        })
      );
    });

    server.addEventListener('message', (event) => {
      if (deepgramSocket.getReadyState() === WebSocket.OPEN) {
        deepgramSocket.send(event.data);
      }
    });

    deepgramSocket.on(LiveTranscriptionEvents.Transcript, (data) => {
      if (server.readyState === WebSocket.OPEN) {
        server.send(JSON.stringify(data));
      }
    });

    server.addEventListener('close', () => {
      deepgramSocket.requestClose();
    });

    deepgramSocket.on(LiveTranscriptionEvents.Error, (error) => {
      if (server.readyState === WebSocket.OPEN) {
        server.close(1011, 'Deepgram error: ' + error.message);
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        'dg-request-id': requestId,
      },
    });
  } catch (error) {
    console.error('WebSocket upgrade failed:', error);
    return createErrorResponse(500, 'WebSocket upgrade failed');
  }
}