var RSAVerifier = require('./helpers/rsa-verifier');
var base64 = require('./helpers/base64');
var jwks = require('./helpers/jwks');
var error = require('./helpers/error');
var DummyCache = require('./helpers/dummy-cache');
var supportedAlgs = ['RS256'];

/**
 * Creates a new id_token verifier
 * @constructor
 * @param {Object} parameters
 * @param {String} parameters.issuer name of the issuer of the token
 * that should match the `iss` claim in the id_token
 * @param {String} parameters.audience identifies the recipients that the JWT is intended for
 * and should match the `aud` claim
 * @param {Object} [parameters.jwksCache] cache for JSON Web Token Keys. By default it has no cache
 * @param {String} [parameters.expectedAlg='RS256'] algorithm in which the id_token was signed
 * and will be used to validate
 * @param {number} [parameters.leeway=0] number of seconds that the clock can be out of sync
 * while validating expiration of the id_token
 */
function IdTokenVerifier(parameters) {
  var options = parameters || {};

  this.jwksCache = options.jwksCache || new DummyCache();
  this.expectedAlg = options.expectedAlg || 'RS256';
  this.issuer = options.issuer;
  this.audience = options.audience;
  this.leeway = options.leeway || 0;
  this.__disableExpirationCheck = options.__disableExpirationCheck || false;

  if (this.leeway < 0 || this.leeway > 60) {
    throw new error.ConfigurationError('The leeway should be positive and lower than a minute.');
  }

  if (supportedAlgs.indexOf(this.expectedAlg) === -1) {
    throw new error.ConfigurationError('Algorithm ' + this.expectedAlg +
      ' is not supported. (Expected algs: [' + supportedAlgs.join(',') + '])');
  }
}

/**
 * @callback verifyCallback
 * @param {Error} [err] error returned if the verify cannot be performed
 * @param {boolean} [status] if the token is valid or not
 */

/**
 * Verifies an id_token
 *
 * It will validate:
 * - signature according to the algorithm configured in the verifier.
 * - if nonce is present and matches the one provided
 * - if `iss` and `aud` claims matches the configured issuer and audience
 * - if token is not expired and valid (if the `nbf` claim is in the past)
 *
 * @method verify
 * @param {String} token id_token to verify
 * @param {String} [nonce] nonce value that should match the one in the id_token claims
 * @param {verifyCallback} cb callback used to notify the results of the validation
 */
IdTokenVerifier.prototype.verify = function (token, nonce, cb) {
  var jwt = this.decode(token);

  if (jwt instanceof Error) {
    return cb(jwt, false);
  }

  /* eslint-disable vars-on-top */
  var headAndPayload = jwt.encoded.header + '.' + jwt.encoded.payload;
  var signature = base64.decodeToHEX(jwt.encoded.signature);

  var alg = jwt.header.alg;
  var kid = jwt.header.kid;

  var aud = jwt.payload.aud;
  var iss = jwt.payload.iss;
  var exp = jwt.payload.exp;
  var nbf = jwt.payload.nbf;
  var tnonce = jwt.payload.nonce || null;
  /* eslint-enable vars-on-top */

  if (this.issuer !== iss) {
    return cb(new error.TokenValidationError('Issuer ' + iss + ' is not valid.'), false);
  }

  if (this.audience !== aud) {
    return cb(new error.TokenValidationError('Audience ' + aud + ' is not valid.'), false);
  }

  if (this.expectedAlg !== alg) {
    return cb(new error.TokenValidationError('Algorithm ' + alg +
      ' is not supported. (Expected algs: [' + supportedAlgs.join(',') + '])'), false);
  }

  if (tnonce !== nonce) {
    return cb(new error.TokenValidationError('Nonce does not match.'), false);
  }

  var expirationError = this.verifyExpAndNbf(exp, nbf); // eslint-disable-line vars-on-top

  if (expirationError) {
    return cb(expirationError, false);
  }

  return this.getRsaVerifier(iss, kid, function (err, rsaVerifier) {
    if (err) {
      return cb(err);
    }
    if (rsaVerifier.verify(headAndPayload, signature)) {
      return cb(null, jwt.payload);
    }
    return cb(new error.TokenValidationError('Invalid signature.'));
  });
};

/**
 * Verifies that the `exp` and `nbf` claims are valid in the current moment.
 *
 * @method verifyExpAndNbf
 * @param {String} exp value of `exp` claim
 * @param {String} nbf value of `nbf` claim
 * @return {boolean} if token is valid according to `exp` and `nbf`
 */
IdTokenVerifier.prototype.verifyExpAndNbf = function (exp, nbf) {
  var now = new Date();
  var expDate = new Date(0);
  var nbfDate = new Date(0);

  if (this.__disableExpirationCheck) {
    return null;
  }

  expDate.setUTCSeconds(exp + this.leeway);

  if (now > expDate) {
    return new error.TokenValidationError('Expired token.');
  }

  if (typeof nbf === 'undefined') {
    return null;
  }
  nbfDate.setUTCSeconds(nbf - this.leeway);
  if (now < nbfDate) {
    return new error.TokenValidationError('The token is not valid until later in the future. ' +
      'Please check your computed clock.');
  }

  return null;
};

/**
 * Verifies that the `exp` and `iat` claims are valid in the current moment.
 *
 * @method verifyExpAndIat
 * @param {String} exp value of `exp` claim
 * @param {String} iat value of `iat` claim
 * @return {boolean} if token is valid according to `exp` and `iat`
 */
IdTokenVerifier.prototype.verifyExpAndIat = function (exp, iat) {
  var now = new Date();
  var expDate = new Date(0);
  var iatDate = new Date(0);

  if (this.__disableExpirationCheck) {
    return null;
  }

  expDate.setUTCSeconds(exp + this.leeway);

  if (now > expDate) {
    return new error.TokenValidationError('Expired token.');
  }

  iatDate.setUTCSeconds(iat - this.leeway);

  if (now < iatDate) {
    return new error.TokenValidationError('The token was issued in the future. ' +
      'Please check your computed clock.');
  }
  return null;
};

IdTokenVerifier.prototype.getRsaVerifier = function (iss, kid, cb) {
  var _this = this;
  var cachekey = iss + kid;

  if (!this.jwksCache.has(cachekey)) {
    jwks.getJWKS({
      iss: iss,
      kid: kid
    }, function (err, keyInfo) {
      if (err) {
        cb(err);
      }
      _this.jwksCache.set(cachekey, keyInfo);
      cb(null, new RSAVerifier(keyInfo.modulus, keyInfo.exp));
    });
  } else {
    var keyInfo = this.jwksCache.get(cachekey); // eslint-disable-line vars-on-top
    cb(null, new RSAVerifier(keyInfo.modulus, keyInfo.exp));
  }
};


/**
 * @typedef DecodedToken
 * @type {Object}
 * @property {Object} header - content of the JWT header.
 * @property {Object} payload - token claims.
 * @property {Object} encoded - encoded parts of the token.
 */

/**
 * Decodes a well formed JWT without any verification
 *
 * @method decode
 * @param {String} token decodes the token
 * @return {DecodedToken} if token is valid according to `exp` and `nbf`
 */
IdTokenVerifier.prototype.decode = function (token) {
  var parts = token.split('.');
  var header;
  var payload;

  if (parts.length !== 3) {
    return new error.TokenValidationError('Cannot decode a malformed JWT');
  }

  try {
    header = JSON.parse(base64.decodeToString(parts[0]));
    payload = JSON.parse(base64.decodeToString(parts[1]));
  } catch (e) {
    return new error.TokenValidationError('Token header or payload is not valid JSON');
  }

  return {
    header: header,
    payload: payload,
    encoded: {
      header: parts[0],
      payload: parts[1],
      signature: parts[2]
    }
  };
};

module.exports = IdTokenVerifier;
