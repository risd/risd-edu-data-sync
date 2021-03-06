var debug = require('debug')('firebase-ref');
var from = require('from2-array');
var through = require('through2');
var miss = require('mississippi')

module.exports = FirebaseRef;

/**
 * FirebaseRef
 * 
 * Returns object stream that pushes a
 * firebase object that has been configured
 * for the current WebHook site.
 *
 * @param {object} options
 * @param {string} options.firebaseName  The name of the firebase
 * @param {string} options.firebaseKey   The key of the firebase
 * @param {string} options.siteName      The site instance
 * @param {string} options.siteKey       The key for the site
 * @returns {Stream} firebaseRef
 */

function FirebaseRef ( options, callback ) {
  if ( !options ) options = {}

  var pipeline = [
    from.obj([ options, null]),
    FirebaseToken(),
    FirebaseAuth(),
    FirebaseBucketForSite(),
  ]

  if ( typeof callback === 'function' ) pipeline = pipeline.concat( [ CallbackRef ] )
  else pipeline = pipeline.concat( [ PushRef() ] )

  return miss.pipe.apply( null, pipeline.concat( [ ErrorHandler ] ) )

  function CallbackRef () {
    return through.obj( function ( firebaseref, enc, next ) {
      callback( null, firebaseref )
    } )
  }

  function ErrorHandler ( error ) {
    if ( error && callback ) callback( error )
  }

  /**
   * @param {object} options
   * @param {object} options.email
   * @param {object} options.password
   * @param {object} options.firebase
   */
  function FirebaseToken () {
      if ( !options ) options = {};
      var request = require('request');
      var authUrl = 'https://auth.firebase.com/auth/firebase';


      return through.obj(createToken);

      function createToken (row, enc, next) {
          var self = this;
          var qs = options;

          debug('token:request');

          request(
              authUrl,
              { qs: options },
              function (err, res, body) {
                  var data = JSON.parse(body);
                  debug('token:reseponse:', JSON.stringify(data));
                  self.push( data );
                  next();
              });
      }
  }

  /**
   * @param {object} options
   * @param {object} options.firebase
   */
  function FirebaseAuth () {
      if ( !options ) options = {}

      var Firebase = require('firebase');
      var dbName = options.firebaseName;
      var dbKey = options.firebaseKey;

      return through.obj(auth);

      function auth (row, enc, next) {
          var self = this;
          var firebase = new Firebase(
                              'https://' +
                              dbName +
                              '.firebaseio.com/');
          debug('auth:token', dbKey);
          firebase
              .auth(
                  dbKey,
                  function (error, auth) {
                      if (error) {
                          console.log(error);
                      } else {
                          self.push({
                              firebaseRoot: firebase
                          });
                      }
                      next();
                  });
      }
  }

  /**
   * @param {object} options
   * @param {string} options.siteName  The site instance
   * @param {string} options.siteKey   The site key
   */
  function FirebaseBucketForSite () {
      var fs = require('fs');
      return through.obj(conf);

      function conf (row, enc, next) {
          row.firebase =
                  row.firebaseRoot
                     .child(
                          'buckets/' +
                          options.siteName +
                          '/' +
                          options.siteKey +
                          '/dev');

          this.push(row);
          next();
      }
  }

  function PushRef () {
      return through.obj(ref);

      function ref (row, enc, next) {
          this.push(row.firebase);

          next();
      }
  }

}
