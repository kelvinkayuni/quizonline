import { supabase } from './supabase.js';

const TABLE = 'semantic_cartographer_documents';
const MAX_FILE_BYTES = 12 * 1024 * 1024;

export async function extractCartographerFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than the 12 MB upload limit.`);
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'txt' || file.type === 'text/plain') {
    return { name: file.name, source_type: 'text', text_content: await file.text() };
  }
  if (extension !== 'pdf' && file.type !== 'application/pdf') throw new Error(`Unsupported file type: ${file.name}`);
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
  }
  return { name: file.name, source_type: 'pdf', text_content: pages.join('\n'), page_count: pdf.numPages };
}

export async function listCartographerDocuments() {
  const { data, error } = await supabase.from(TABLE).select('id, name, source_type, text_content, word_count, created_at').order('created_at', { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function insertCartographerDocument(document) {
  const { data, error } = await supabase.from(TABLE).insert(document).select('id, name, source_type, text_content, word_count, created_at').single();
  if (error) throw new Error(error.message);
  return data;
}

export async function removeCartographerDocument(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(error.message);
}