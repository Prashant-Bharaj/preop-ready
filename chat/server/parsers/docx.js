/**
 * DOCX parser — mammoth extracts raw text from modern Word docs.
 */

import mammoth from 'mammoth';

const PREVIEW_BYTES = 2048;

export default {
  extensions: ['docx'],
  async parse(absPath) {
    const result = await mammoth.extractRawText({ path: absPath });
    const text = (result.value || '').trim();
    const paragraphs = text.split(/\n+/).filter(Boolean).length;
    return {
      preview: text.slice(0, PREVIEW_BYTES),
      summary: `Word document, ${paragraphs} paragraph${paragraphs === 1 ? '' : 's'}, ~${text.length} chars`,
      extractedText: text.length <= 16 * 1024 ? text : undefined,
      structure: { paragraphs, charCount: text.length },
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  },
};
