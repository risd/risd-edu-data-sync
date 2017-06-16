var debug = require('debug')('env');
var dotenv = require('dotenv-safe');

module.exports = Env;

/**
 * Env configuration object based on dotenv-safe.
 * Options into this function are passed into dotenv-safe.
 *
 * Env configuration includes 
 *
 * SITE_NAME
 * FIREBASE_NAME
 * FIREBASE_KEY
 * AWS_KEY
 * AWS_SECRET
 * AWS_BUCKET
 * ELASTIC_SEARCH_SERVER
 * ELASTIC_SEARCH_USER
 * ELASTIC_SEARCH_PASSWORD
 * 
 * @param {object} options Defaults to process.env
 * @returns {object}   interface
 *          {Function} interface.asObject Returns environment as object
 *          {Function} interface.asString Returns environment as string
 */
function Env ( options ) {
  if ( ! ( this instanceof Env ) ) return new Env( options );
  if ( !options  ) options = {}

  var defaultOptions = {
    path: '.env',
    allowEmptyValues: false,
    sample: '.env.example',
  }
  
  try {
    var environment = dotenv.load( Object.assign( defaultOptions, options ) ).parsed;
  } catch ( error ) {
    // These are expected as process.env variables if there is no `.env` file
    debug( 'loading-from-process.env' )
    var environment = process.env;
  }

  var configuration = {
    elasticSearch: {
      server  : environment.ELASTIC_SEARCH_SERVER,
      user    : environment.ELASTIC_SEARCH_USER,
      password: environment.ELASTIC_SEARCH_PASSWORD,
      siteName: environment.SITE_NAME,
    },
    firebase: {
      firebaseName: environment.FIREBASE_NAME,
      firebaseKey : environment.FIREBASE_KEY,
      siteName    : environment.SITE_NAME,
      siteKey     : environment.SITE_KEY,
    },
    build: {
      siteName: environment.SITE_NAME,
    },
    aws: {
      key: environment.AWS_KEY,
      secret: environment.AWS_SECRET,
      bucket: environment.AWS_BUCKET,
    }
  }

  debug( configuration.elasticSearch )
  debug( configuration.firebase )
  debug( configuration.build )
  debug( configuration.aws )

  return {
    asObject: extendConfiguration,
    asString: asString,
  }

  function extendConfiguration () {
    return Object.assign( {}, configuration )
  }

  function asString () {
    var str = '';
    for ( var key in environment ) {
      str = [ str, key, '=', environment[ key ], ' ' ].join( '' )
    }
    return str;
  }
}
