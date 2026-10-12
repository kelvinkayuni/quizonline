import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function isEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length) throw new Error('Embedding dimensions did not match.');

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  const denominator = Math.sqrt(leftMagnitude * rightMagnitude);
  if (!denominator) throw new Error('The model returned an empty embedding.');
  return Math.max(0, Math.min(1, dot / denominator));
}

serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  try {
    let payload: { expectedAnswer?: unknown; studentResponse?: unknown };
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'Request body must be valid JSON.' }, 400);
    }

    const expectedAnswer = typeof payload.expectedAnswer === 'string' ? payload.expectedAnswer.trim() : '';
    const studentResponse = typeof payload.studentResponse === 'string' ? payload.studentResponse.trim() : '';
    if (!expectedAnswer || !studentResponse) return jsonResponse({ error: 'Expected answer and student response are required.' }, 400);

    const hfToken = Deno.env.get('HUGGINGFACE_API_KEY');
    if (!hfToken) return jsonResponse({ error: 'Hugging Face inference is not configured.' }, 500);

    const response = await fetch(
      'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs: [expectedAnswer, studentResponse], normalize: true }),
        signal: AbortSignal.timeout(25000)
      }
    );

    if (!response.ok) {
      console.error('Hugging Face inference failed with status', response.status);
      return jsonResponse({ error: 'Hugging Face inference failed.' }, 502);
    }

    const embeddings: unknown = await response.json();
    if (!Array.isArray(embeddings) || embeddings.length !== 2 || !isEmbedding(embeddings[0]) || !isEmbedding(embeddings[1])) {
      console.error('Hugging Face returned an invalid embedding response.');
      return jsonResponse({ error: 'Hugging Face returned an invalid embedding response.' }, 502);
    }

    return jsonResponse({ score: cosineSimilarity(embeddings[0], embeddings[1]) });
  } catch (error) {
    console.error('swift-processor failed:', error instanceof Error ? error.name : 'Unknown error');
    return jsonResponse({ error: 'Short-answer semantic scoring failed.' }, 502);
  }
});