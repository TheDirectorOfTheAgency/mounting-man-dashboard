import { uploadOfflineConversion } from '../lib/google-ads-conversions.js';

async function main() {
  const result = await uploadOfflineConversion({
    email: 'validation-only@example.invalid',
    phone: '+12025550123',
    firstName: 'Validation',
    lastName: 'Only',
    conversionValue: 1,
    conversionDateTime: new Date().toISOString(),
    orderId: `codex_validate_${Date.now()}`,
    validateOnly: true,
  });

  console.log(JSON.stringify({
    success: result.success,
    validated: result.validated || false,
    retryable: result.retryable,
    errorCode: result.errorCode,
    googleRequestId: result.googleRequestId ? '[PRESENT]' : null,
    partialFailureCode: result.partialFailureError?.code || null,
  }));

  if (!result.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
