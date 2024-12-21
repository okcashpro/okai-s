import OpenAI from 'openai';
import { config } from './config/env';
import type { Message } from './types';
import type { AIPersona } from './config/personas/types';
import { processMessages } from './utils/messageProcessor';
import { formatResponse } from './utils/responseFormatter';
import { findBestMatch, integrateKnowledge } from './utils/knowledgeIntegration';
import { validateMessages } from './utils/validation';
import { logger } from './utils/logger';
import { analytics } from './utils/analytics';
import { metrics } from './utils/metrics';
import { RateLimiter } from './utils/rateLimit';

const DEFAULT_MODEL = "cognitivecomputations/dolphin-mixtral-8x22b";
const rateLimiter = RateLimiter.getInstance();

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openRouterApiKey,
  defaultHeaders: {
    "HTTP-Referer": config.siteUrl,
    "X-Title": config.appName,
  },
  dangerouslyAllowBrowser: true
});

export async function sendMessage(messages: Message[], persona: AIPersona): Promise<Message | undefined> {
  const requestId = crypto.randomUUID();
  
  try {
    metrics.recordMetric('message_request_start', 1);

    if (!rateLimiter.checkLimit(requestId)) {
      throw new Error('Rate limit exceeded');
    }

    validateMessages(messages);
    const processedMessages = processMessages(messages);
    
    // Get knowledge context
    const integrated = await integrateKnowledge(persona);
    const matchingQA = await findBestMatch(processedMessages[processedMessages.length - 1].content, persona);

    // Create system message with integrated knowledge
    const systemMessage = {
      role: 'system' as const,
      content: `${persona.systemPrompt}

KNOWLEDGE BASE INTEGRATION:
1. Topics of Expertise: ${integrated.topics.join(', ')}
2. Context-Specific Instructions: ${integrated.prompts.join(' ')}

${matchingQA ? `VERIFIED KNOWLEDGE BASE ANSWER:
Source: ${matchingQA.source}
Category: ${matchingQA.category}
Answer: "${matchingQA.answer}"` : ''}

RESPONSE GUIDELINES:
1. Primary Source: Always prioritize knowledge base answers when available
2. Consistency: Maintain ${persona.name}'s personality and style
3. Accuracy: Only use verified information from the knowledge base
4. Fallback: Use general knowledge only when no knowledge base match exists`
    };

    const completion = await openai.chat.completions.create({
      model: persona.model || DEFAULT_MODEL,
      messages: [systemMessage, ...processedMessages.map(m => ({ role: m.role, content: m.content }))]
    });

    const response = completion.choices[0].message;
    if (!response?.content) return undefined;

    const formattedResponse = formatResponse(
      { id: crypto.randomUUID(), role: 'assistant', content: response.content },
      persona
    );

    analytics.trackEvent('message_sent', {
      persona: persona.name,
      hasKnowledgeMatch: !!matchingQA,
      requestId
    });

    return formattedResponse;

  } catch (error) {
    logger.error('Error in sendMessage:', error);
    throw error;
  }
}