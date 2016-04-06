// Initializing any sync source will attempt to
// make a connection to s3, where the source
// files are stored.
require('../../../env.js')();

var through = require('through2');

var whUtil = require('../../whUtil.js')();
var Courses = require('../../courses/index.js')();
var Employee = require('../../employees/index.js')();

Employee.listSource()
  .pipe(formatEmployees())
  .on('data', function (e) {
    Courses.listSource()
      .pipe(formatCourses(e))
      .pipe(report())
      .pipe(process.stdout);
  });

function report () {
  return through.obj(function (row, enc, next) {
    for (var department in row) {
      var employees = Object.keys(row[department]);
      var r = department + ', ' + employees.length;
      r += '\n---\n'
      employees
        .sort(function (a_id, b_id) {
          if (row[department][a_id].last < row[department][b_id].last) {
            return -1;
          }
          if (row[department][a_id].last > row[department][b_id].last) {
            return 1;
          }
          return 0;
        })
        .forEach(function (e_id, i) {
          r += row[department][e_id].first + ' ' + row[department][e_id].last + '\n'
        });
      r += '\n';

      this.push(r);
    }
    next();
  });
}

function formatEmployees () {
  var data = {};

  return through.obj(function onwrite (row, enc, next) {
    var s = Employee.updateWebhookValueWithSourceValue({}, row);
    data[Employee.keyFromWebhook(s)] = s.colleague_person;
    next();
  },
  function onend () {
    this.push(data);
    this.push(null);
  });
}

function formatCourses (employees) {
  var departments = {};
  return through.obj(function onwrite (row, enc, next) {
    var s = Courses.updateWebhookValueWithSourceValue({}, row);
    // Is the faculty who is teaching the class in
    // the list of employees?
    if (s.colleague_course_faculty_id in employees) {
      // Is the department for the course in the departments 
      // object used for reporting?
      if (!(s.colleague_departments[0].department in departments)) {
        // If not, make an array that will store employees
        departments[s.colleague_departments[0].department] = {};
      }

      // See if the person is already in the list
      if (!(s.colleague_course_faculty_id in
            departments[s.colleague_departments[0].department])) {
        // if not, add them
        departments
          [s.colleague_departments[0].department]
          [s.colleague_course_faculty_id] =
            employees[s.colleague_course_faculty_id];
      }
    }
    next();
  },
  function onend () {
    this.push(departments);
    this.push(null);
  });
}