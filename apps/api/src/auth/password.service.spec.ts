import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and verifies the original', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await service.verify(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(await service.verify(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([service.hash('same-password'), service.hash('same-password')]);
    expect(a).not.toBe(b);
  });

  it('never returns the plaintext inside the hash', async () => {
    const hash = await service.hash('super-secret-value');
    expect(hash).not.toContain('super-secret-value');
  });

  it('fails closed on a malformed stored hash instead of throwing', async () => {
    expect(await service.verify('not-a-hash', 'anything')).toBe(false);
  });

  it('dummyVerify burns comparable time and does not throw', async () => {
    const start = Date.now();
    await service.dummyVerify();
    // Argon2id at these parameters is milliseconds, not microseconds — enough that a
    // "no such user" response is not conspicuously faster than a real check.
    expect(Date.now() - start).toBeGreaterThan(1);
  });
});
