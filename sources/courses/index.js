var debug = require('debug')('courses');

var fs = require('fs');
var through = require('through2');
var xmlStream = require('xml-stream');
var knox = require('knox');
var cheerio = require('cheerio');
var miss = require('mississippi')

var whUtil = require('../whUtil.js')();

module.exports = Courses;


/**
 * Courses are provided via XML dump from Colleague.
 * 
 * @param {object} options
 * @param {object?} options.aws
 * @param {string?} options.fsSource
 */
 function Courses ( options ) {
   if (!(this instanceof Courses)) return new Courses( options );
   var self = this;
   this.aws = options.aws;
   this.fsSource = options.fsSource;
 }

 Courses.prototype.webhookContentType = 'courses';
 Courses.prototype.keyFromWebhook = function (row) {
   return row.name;
 };
 Courses.prototype.keyFromSource = function (row) {
   return [row.COURSESYNONYM,
   row.COURSENAME,
   row.COURSETERM].join(' ');
 };

 Courses.prototype.listSource = function () {
   var self = this;
   debug('Courses.listSource::start');

   var eventStream = through.obj();

   var seed = through.obj();

   if ( self.fsSource ) {
        var sourceStream = fsStream()
        process.nextTick( function startStream () {
            self.fsSource.map( function ( fsSource ) {
                seed.push( fsSource )
            } )
            seed.push( null )
        } )
    }
    else {
        var sourceStream = s3Stream()
        process.nextTick( function startStream () {
            self.aws.path.map( function ( awsPath ) {
                seed.push( awsPath )
            } )
            seed.push( null )
        } )
    }


    var drain = drainXMLResIntoStream(eventStream)

    miss.pipe(
      seed,
      sourceStream,
      drain.stream,
      function onComplete ( error ) {
        if ( error ) eventStream.emit( 'error', error )
        else if ( ! drain.completed() ) eventStream.emit( 'error', new Error( 'Source stream not completed.' ) )
        eventStream.push( null )
      })

   return eventStream;

   function s3Stream() {
     var aws = knox.createClient( self.aws )

     return through.obj(s3ify);

     function s3ify (path, enc, next) {
       var stream = this;

       aws.getFile(path, function (err, res) {
         if (err) {
           stream.emit('error', err);
         } else {
           var sourceSpecification = { path: path, xmlDocument: res };
           stream.push(sourceSpecification);
         }

         next();
       });
     }
   }

   function fsStream () {
     return through.obj(local);

     function local (path, enc, next) {
       var fileStream = fs.createReadStream(path);
       var sourceSpecification = { path: path, xmlDocument: fileStream };
       next(null, sourceSpecification);
     }
   }

   function drainXMLResIntoStream (writeStream) {
     var started = false
     var xmlCount = 0

     return {
       completed: function () { return started && xmlCount === 0 },
       stream: through.obj(drain),
     };

      function drain (sourceSpecification, enc, next) {
        started = true
        xmlCount += 1

        var stream = this;
        var sourceXmlDocument = sourceSpecification.xmlDocument;
        var sourcePath = sourceSpecification.path;
        var xml = new xmlStream(sourceXmlDocument, 'iso-8859-1');

        // capture all departments per course
        xml.collect('COURSE');
        xml.collect('COURSEFACULTY');
        xml.on('error', function (err) {
          stream.emit('error', err);
        });
        xml.on('endElement: DEPARTMENT', function (row) {
          row.COURSE.forEach(function (d) {
            d.departments = [row.NAME.trim()];
            d.sourcePath = sourcePath;
            writeStream.push(d);
          });
        });

        xml.on( 'endElement: ROOT', function () {
            debug('listSource::end-of-file');
            xmlCount -= 1
        } )

        xml.on('end', function () {
          next();
        });
      }
    }
  };

/**
 * Course data is formatted by department, instead of by
 * course name with a listing of departments that the course
 * is offered through. In order to individual courses being
 * offered through multiple departments, we need a different
 * stream process than the SyncProtocol offers.
 *
 * This one checks to see if a value exists before writing
 * it to the firebase, since duplicate entries are expected,
 * each with their own department value, which will be
 * aggregated in a single array.
 * 
 * @return through.obj stream
 */
 Courses.prototype.sourceStreamToFirebaseSource = function () {
  var self = this;

  return through.obj(toFirebase);

  function toFirebase (row, enc, next) {
    debug('source-stream-to-firebase-source:row');
    var stream = this;

    var key = self.keyFromSource(row);
      // check if in firebase
      self._firebase
      .source
      .child(key)
      .once('value', onCheckComplete, onCheckError);

    // if so, see if the department needs to be added
    // if not, add it
    function onCheckComplete (snapshot) {
      var value = snapshot.val();
      if (value) {
        // value exists, see if department needs to be added
        if (value.departments.indexOf(row.departments[0]) > -1) {
            // department is already in list
            onAddComplete();
          } else {
            // department needs to be added
            var departments =
            value
            .departments
            .concat(row.departments);

            self._firebase
            .source
            .child(key)
            .child('departments')
            .set(departments, onAddComplete);
          }
        } else {
        // value does not exist, add it
        self._firebase
        .source
        .child(key)
        .set(row, onAddComplete);
      }
    }

    function onCheckError (error) {
      stream.emit('error', error);
      onAddComplete();
    }

    function onAddComplete () {
      next();
    }
  }
};

Courses.prototype.updateWebhookValueWithSourceValue = function (wh, src) {
  wh.name = this.keyFromSource(src);
  wh.colleague_departments =
  src.departments
  .map(function (d) {
    return { department: d };
  });
  wh.colleague_course_title = toTitleCase(src.COURSETITLE);
  wh.colleague_course_name = src.COURSENAME;
  wh.colleague_course_description = formatDescription(src.COURSEDESC);
  wh.colleague_course_term = src.COURSETERM;
  wh.colleague_course_credits = src.COURSECREDITS;
  wh.colleague_course_academic_level = src.COURSEACADEMICLEVEL;
  wh.colleague_course_faculty = mapCourseFaculty( src.COURSEFACULTY );

  return wh;

  function toTitleCase (str) {
    return str.replace(
      /\w\S*/g,
      function (txt) {
        return txt.charAt(0)
        .toUpperCase() +
        txt.substr(1)
        .toLowerCase();
      }
      )
    .replace(/ Iiia/g, ' IIIA')
    .replace(/ Iiib/g, ' IIIB')
    .replace(/ Iii/g, ' III')
    .replace(/ Iia/g,  ' IIA')
    .replace(/ Iib/g,  ' IIB')
    .replace(/ Ii/g,  ' II')
    .replace(/ Ia/g,  ' IA')
    .replace(/ Ib/g,  ' IB')
    .replace(/ Iv/g,  ' IV')
    .replace(/Xd/g,  'XD')
    .replace(/Xxxy/g,  'XXXY')
    .replace(/Ehp /g, 'EHP ')
    .replace(/Isp /g, 'ISP ')
    .replace(/Havc /g, 'HAVC ')
    .replace(/Ncss /g, 'NCSS ')
    .replace(/Hpss /g, 'HPSS ')
    .replace(/Thad/g, 'THAD')
    .replace(/Lael /g, 'LAEL ')
    .replace(/Id /g,   'ID ')
    .replace(/Id:/g,   'ID: ')
    .replace(/Las /g,  'LAS ')
    .replace(/Risd /g,  'RISD ')
    .replace(/Cad /g,  'CAD ')
    .replace(/ Cad/g,  ' CAD')
    .replace(/J\+m /g,  'J+M ')
    .replace(/D\+m /g,  'D+M ')
    .replace(/Dm /g,  'DM ')
    .replace(/Fav /g,  'FAV ')
    .replace(/T&m /g,  'T&M ')
    .replace(/ And /g,  ' and ')
    .replace(/ Or /g,  ' or ')
    .replace(/3d/g,  '3-D')
    .replace(/2-d/g,  '2-D')
    .replace(/3-d/g,  '3-D')
    .replace(/X,y, and Z/g,  'X,Y, and Z')
  }

  function formatDescription (desc) {
    return [desc]
    .map(replaceBrWithP)
    .map(ensureWrapInP)
    .map(ensureValid)
    .map(replaceBWithStrong)
    .map(replaceIWithEm)
    [0];

    function ensureWrapInP (body) {
      if (body.length === 0) {
        return body;
      }
      if (!(body.indexOf('<p>') === 0)) {
        body = '<p>' + body;
      }
      if (!(body.indexOf('</p>') === (body.length - 5))) {
        body = body + '</p>';   
      }
      return body;
    }

    function replaceBrWithP (body) {
      return body
      .replace(/<br>/g, '</p><p>')
      .replace(/<BR>/g, '</p><p>');
    }

    function replaceBWithStrong (body) {
      return body
        .replace(/<b>/g, '<strong>')
        .replace(/<B>/g, '<strong>')
        .replace(/<\/b>/g, '</strong>')
        .replace(/<\/B>/g, '</strong>')
    }

    function replaceIWithEm (body) {
      return body
        .replace(/<i>/g, '<em>')
        .replace(/<I>/g, '<em>')
        .replace(/<\/i>/g, '</em>')
        .replace(/<\/I>/g, '</em>')
    }

    function ensureValid (body) {
      var $ = cheerio.load('<div class="top">' + body + '</div>');
      return $('.top').html();
    }
  }

  function mapCourseFaculty ( faculty ) {
    if ( Array.isArray( faculty ) ) {
      return faculty.map( function ( fid ) { return { faculty_colleague_id: fid } } )
    }
    return [];
  }
};

Courses.prototype.relationshipsToResolve = function () {
/*
  mutlipleToRelate: boolean
      Are we relating to a one-off or
      mutliple entry content-type
  relationshipKey: string
      What is the name of the key in the
      Course object that is being used to
      store any relationships that are made
  relateToContentType
      The name of the content-type that we
      are creating a relationship to. This is
      the webhook name. All lowercase, no spaces
      or hyphens.
  relateToContentTypeDataUsingKey
      The key in the webhook object that we
      are seeing if we have a relationship to.
      Only used for multiple content-type
      relationships
  itemsToRelate
      The webhook relationship values that
      should be added to the relationshipKey
      for this webhook Course object.
      This will take the form of an array
      with an object that has a key of the
      content-type to compare against,
      and the value of the Course object's
      `relateToContentTypeDataUsingKey` value

*/
  return [{
    multipleToRelate: true,
    relationshipKey: 'related_departments',
    relateToContentType: 'departments',
    relateToContentTypeDataUsingKey: 'name',
    itemsToRelate: []
  }, {
    multipleToRelate: false,
    relationshipKey: 'related_foundation_studies',
    relateToContentType: 'experimentalandfoundationstudies',
    itemToRelate: false
  }, {
    multipleToRelate: false,
    relationshipKey: 'related_graduate_studies',
    relateToContentType: 'graduatestudies',
    itemToRelate: false
  }, {
    multipleToRelate: true,
    relationshipKey: 'related_liberal_arts_departments',
    relateToContentType: 'liberalartsdepartments',
    relateToContentTypeDataUsingKey: 'name',
    itemsToRelate: []
  }, {
    multipleToRelate: true,
    relationshipKey: 'related_employees',
    relateToContentType: 'employees',
    relateToContentTypeDataUsingKey: 'colleague_id',
    itemsToRelate: []
  }];
};


Courses.prototype.dataForRelationshipsToResolve = function (currentWHData) {
  var self = this;

  var toResolve = self.relationshipsToResolve();

  var colleagueDepartments = currentWHData.colleague_departments.map(valueFrom( 'department' ))

  if ( relateCourseToDepartmentBasedOnCourseNameAbbreviation( colleagueDepartments ) ) {

    var courseNameAbbreviation = [ currentWHData.colleague_course_name.split( '-' )[ 0 ] ]

    var departments = courseNameAbbreviation
      .map( whUtil.webhookDepartmentForCourseCatalogueNameAbbreviation )
      .filter( isNotFalse )
      .map( valueAs( 'departments' ) )

    var foundation = courseNameAbbreviation.filter( function ( courseNameAbbr ) {
      return courseNameAbbr === whUtil.webhookFoundationStudiesForCourseCatalogueNameAbbreviation;
    } )

    var graduate = courseNameAbbreviation.filter( function ( courseNameAbbr ) {
      return courseNameAbbr === whUtil.webhookGraduateStudiesForCourseCatalogueNameAbbreviation;
    } )

    var liberalArtsDepartments = courseNameAbbreviation
      .map( whUtil.webhookLiberalArtsDepartmentForCourseCatalogueNameAbbreviation )
      .filter( isNotFalse )
      .map( valueAs( 'liberalartsdepartments' ) )

  } else {

    // relate based on department offering course
    var departments = colleagueDepartments
      .map(whUtil.webhookDepartmentForCourseCatalogue)
      .filter(isNotFalse)
      .map(valueAs( 'departments' ));

    var foundation = colleagueDepartments
      .filter(function (department) {
        return department === whUtil.courseCatalogueFoundationStudies ||
               department === whUtil.courseCatalogueFoundationStudiesConcentrations;
      });

    var graduate = colleagueDepartments
      .filter(function (department) {
        return department === whUtil.courseCatalogueGraduateStudies;
      });

    var liberalArtsDepartments = colleagueDepartments
      .map(whUtil.webhookLiberalArtsDepartmentForCourseCatalogue)
      .filter(isNotFalse)
      .map(valueAs( 'liberalartsdepartments' ));

  }

  toResolve[0].itemsToRelate = departments;

  if (foundation.length === 1) {
    toResolve[1].itemToRelate = true;
  }

  if (graduate.length === 1) {
    toResolve[2].itemToRelate = true;
  }

  toResolve[3].itemsToRelate = liberalArtsDepartments;

  
  if ( checkMakeEmployeeRelationship( currentWHData ) ) {

    toResolve[4].itemsToRelate = currentWHData.colleague_course_faculty
      .map( function ( row ) {
        return { employees: row.faculty_colleague_id }
      } );

  }

  return toResolve;

  function isNotFalse ( value ) { return value !== false }
  function valueFrom ( valueKey ) {
    return function ( value ) { return value[ valueKey ]; }
  }
  function valueAs ( valueKey ) {
    return function ( value ) { var object = {}; object[ valueKey ] = value; return object; }
  }

  function relateCourseToDepartmentBasedOnCourseNameAbbreviation ( colleagueDepartments ) {
    var departmentsToUseCourseNameAbbreviation = [ 'ARCHITECT. & DESIGN' ]
    var relateUsingCourseNameAbbreviation = colleagueDepartments.filter( isDepartmentToUseCourseNameAbbreviation )

    if ( relateUsingCourseNameAbbreviation.length === 1 ) return true;
    else return false;

    function isDepartmentToUseCourseNameAbbreviation ( department ) {
      return departmentsToUseCourseNameAbbreviation.indexOf( department ) !== -1;
    }
  }

  function checkMakeEmployeeRelationship ( wh ) {
    return ( Array.isArray(wh.colleague_course_faculty) && ( !ignoreCoursePrefix( wh ) ) );

    function ignoreCoursePrefix ( course ) {
      // Do not make course <-> employee relationships based on
      // EHP courses. these are all listed as being one individual
      var prefixes = [ 'ehp' ]
      var ignore = false;
      var courseTitle = course.colleague_course_title.toLowerCase()
      prefixes.forEach( function ( prefix ) {
        try {
          if ( courseTitle.indexOf( prefix ) !== -1 ) ignore = true;
        } catch ( error ) {}
        
      } )
      return ignore;
    }
  }

};
