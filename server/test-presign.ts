import { presignUpload, buildObjectKey } from './src/media/presign.js';

async function main() {
  const key = buildObjectKey('test-user', 'chat-voice', { chatId: 'test-chat-123', ext: 'm4a' });
  const target = await presignUpload(key, 'audio/mp4');
  const hasChecksum = target.uploadUrl.includes('x-amz-checksum') || target.uploadUrl.includes('x-amz-sdk-checksum');
  console.log('Has checksum in URL:', hasChecksum);
  console.log('URL preview:', target.uploadUrl.substring(0, 120) + '...');

  // Test actual upload
  const testData = Buffer.from('fake audio bytes for test');
  const res = await fetch(target.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/mp4' },
    body: testData,
  });
  console.log('PUT STATUS:', res.status, res.statusText);
  if (!res.ok) console.log('ERROR:', await res.text());
}
main().catch(console.error);
