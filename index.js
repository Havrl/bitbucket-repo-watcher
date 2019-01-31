const _ = require('lodash');
const moment = require('moment');
const request = require('request');
const Bluebird = require('bluebird');
const rp = require('request-promise');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const config = require('./config');

const commitsUrl = config.bbRepoUrl + 'commits/?page=';
const diffStatUrl = config.bbRepoUrl + 'diffstat/';
const diffUrl = config.bbRepoUrl + 'diff/';

let changedCommits = [];

var authObj = {
  user: config.bbUser,
  pass: config.bbPass,
  sendImmediately: true
};

var scheduleDate = parseScheduleDate(config.scheduleDate);

if(_.isEmpty(scheduleDate)) {
  console.log(`Error -> Scheduler Date is Emtpy.`);
  return;
}

console.log(`Scheduled for ${config.scheduleDate}`);
console.log('Watch list', config.watchList);

var job = schedule.scheduleJob(scheduleDate, function(){
  checkRepo();
});


// showDiff(commitHash);
// showDiffStat(commitHash);

///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////

function parseScheduleDate(val) {
  if(!val) {
    console.log('parseScheduleDate value is empty');
    return null;
  }

  var dateObj = {};
  var parts = val.split(',') || [];
  _.each(parts, part => {
    var prop = part.split(':');
    dateObj[prop[0]] = Number(prop[1]);
  })
  return dateObj;
}

function checkRepo() {
  // Make 4 paged requests which would return 4*30 commits, which should cover about 2 days
  var request1 = rp({ url: commitsUrl + '1', method: 'GET', auth: authObj, json: true });
  var request2 = rp({ url: commitsUrl + '2', method: 'GET', auth: authObj, json: true });
  var request3 = rp({ url: commitsUrl + '3', method: 'GET', auth: authObj, json: true });
  var request4 = rp({ url: commitsUrl + '4', method: 'GET', auth: authObj, json: true });

  Bluebird.all([request1, request2, request3, request4])
    .spread(function(res1, res2, res3, res4) {
      var commits = _.concat(res1.values, res2.values, res3.values, res4.values);

      const mapped = filterCommits(commits);
      console.log('commits num: ', mapped.length);
      checkCommits(mapped);
    })
    .catch(function(err) {
      console.log('Get commits failed', err);
    });
}

function checkCommits(commits) {

  if(!commits || commits.length === 0) {
    return;
  }

  var promises = [];
  for (let i = 0; i < commits.length; i++) {
    promises.push(getDiffStat(commits[i]));
  }

  Bluebird.all(promises).then(function(res) {
    console.log('all completed', changedCommits);
    sendNotification();
  });
}

function getDiffStat(commit) {
  return rp({ url: diffStatUrl + commit.hash, method: 'GET', auth: authObj, json: true })
    .then(function(res) {
      // console.log('Dif', res);

      const paths = [];
      const diffs = res.values || [];

      _.each(diffs, diff => {
        // get path object which could be
        // either old (modified, deleted);
        // or new (added)
        var changed = diff.old || diff.new;
        paths.push(changed.path);
      });

      const isChanged = isAnyWachedChanged(paths);

      if (isChanged) {
        commit.paths = paths;
        changedCommits.push(commit);
      }

      return this;
    })
    .catch(function(err) {
      console.log('getDiffStat error', err);
      return this;
    });
}

function showDiff(hash) {
  var difReq = rp({ url: diffUrl + hash, method: 'GET', auth: authObj, json: true });

  difReq
    .then(function(res) {
      console.log('Dif', res);
    })
    .catch(function(err) {
      console.log('showDiff error', err);
    });
}

function filterCommits(data) {
  let comparedDate = config.commitsFilterDate === 'TODAY' ? moment() : moment(config.commitsFilterDate);

  if (!comparedDate.isValid) {
    console.log('env.COMMITS_FILTER_DATE is invalid');
    return [];
  }

  var filtered = _.filter(data, commit => {

    if(config.commitsFilterDate === 'TODAY') {
      return moment(commit.date).isSame(comparedDate, 'date');
    }
    return moment(commit.date).isAfter(comparedDate, 'date');
    
  });

  var arr = _.map(filtered, commit => {
    return {
      hash: commit.hash,
      message: commit.message,
      author: commit.author.raw,
      date: moment(commit.date).format('LLL')
    };
  });

  // console.log('commits', arr);
  // console.log('filtered count', arr.length);

  return arr;
}

function isAnyWachedChanged(paths) {
  let found = false;

  _.each(paths, path => {
    found = config.watchList.some(interested => path.indexOf(interested) > -1);
    if (found) {
      return;
    }
  });

  if(found) {
    console.log('isAnyWatchedChanged', found);
  }
  
  return found;
}

function sendNotification() {
  if (changedCommits.length === 0) {
    return;
  }

  let content = '';
  _.each(changedCommits, changed => {
    content += buildCommitContent(changed);
    content += '<hr>';
  });

  content += `<h5>Sent by Bitbucket-Repo-Notifier | ${moment().format('LLL')}</h5>`;

  console.log('email content', content);

  sendEmail(content).catch(console.error);
}

function buildCommitContent(commit) {
  let content = `
  <b>Commit:</b> ${commit.hash}<br/>
  <b>Author:</b> ${commit.author}<br/>
  <b>Date:</b> ${commit.date}<br/>
  <b>Message:</b><br/>
  ${commit.message} <br/><br/>
  <b>Changes:</b><br/>
  ${buildPathsContent(commit.paths)}
  <br/>
  `;

  return content;
}

function buildPathsContent(paths) {
  let rows = '';
  _.each(paths, path => {
    rows += `<tr><td>${path}</td></tr>`;
  });

  return `<table>${rows}</table>`;
}

async function sendEmail(body) {
  // Generate test SMTP service account from ethereal.email
  // Only needed if you don't have a real mail account for testing
  // let account = await nodemailer.createTestAccount();

  // create reusable transporter object using the default SMTP transport
  let transporter = nodemailer.createTransport({
    service: config.emailProvider,
    auth: {
      user: config.emailUser,
      pass: config.emailPass
    }
  });

  // setup email data with unicode symbols
  let mailOptions = {
    from: `"Bitbucket Notifier" <${config.emailFrom}>`, // sender address
    to: config.emailTo, // list of receivers
    subject: `Bitbucket changes for ${config.bbRepoDesc}`, // Subject line
    text: '', // plain text body
    html: body // html body
  };

  // send mail with defined transport object
  let info = await transporter.sendMail(mailOptions);

  console.log('Message sent: %s', info.messageId);
}
