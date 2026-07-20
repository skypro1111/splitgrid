// Legacy SSH algorithms appended to ssh2's secure defaults so we can still
// negotiate with old servers (OpenSSH/Dropbear that only speak SHA-1 KEX or
// offer ssh-rsa/ssh-dss host keys). This mirrors an OpenSSH client config of:
//
//   KexAlgorithms +diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1
//   HostKeyAlgorithms +ssh-rsa,ssh-dss
//
// They are APPENDED (lowest preference), never prepended — modern servers keep
// negotiating their strongest mutual algorithm; these only kick in as a fallback
// when the server offers nothing better. Pass as the `algorithms` connect option.
//
// NOTE on `diffie-hellman-group1-sha1`: deliberately NOT included. We run on
// Electron, whose crypto is BoringSSL, and BoringSSL does not implement the
// modp1/modp2 named DH groups — ssh2 maps group1-sha1 → 'modp2' and the exchange
// then throws "Unknown DH group" (ERR_CRYPTO_UNKNOWN_DH_GROUP). group14-sha1
// (modp14) and group-exchange-sha1 (server-supplied prime) work fine and cover
// virtually every server that would have offered group1 anyway.
//
// Loosely typed on purpose: @types/ssh2 models each category as a Record that
// requires append/prepend/remove together, which we don't want.
export const LEGACY_SSH_ALGORITHMS = {
  kex: {
    append: [
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group-exchange-sha1',
    ],
  },
  // `ssh-rsa` (RSA host key, SHA-1 signature) is the common legacy host-key
  // algorithm and verifies fine on BoringSSL. `ssh-dss` is intentionally omitted:
  // BoringSSL has no DSA, so we couldn't verify a DSA host key anyway — advertising
  // it would only turn a clean "no compatible host key" into a crypto error.
  serverHostKey: {
    append: ['ssh-rsa'],
  },
};
