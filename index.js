#!/usr/bin/env node

const childProcess = require("child_process");
const request = require("request");
const path = require("path");
const rimraf = require("rimraf");
const fs = require("fs");
const showdown = require("showdown");

const staticDirectory = path.join(__dirname, "static");
const lockFile = readLockFile();
const outputDirectory = getOutputDirectoryPath();

const converter = new showdown.Converter();
converter.setFlavor("github");

main();

// main
// ===================

async function main() {
  const allDependencyList = await getOutdatedDependencies();
  const allKeyList = Object.keys(allDependencyList);
  clearOutputDirectory();

  let i = 0;
  const allChangelogList = [];
  for (const key of allKeyList) {
    i++;
    const dependency = allDependencyList[key];

    console.log(``);
    logMessage(`${key} (${i}/${allKeyList.length})`);

    const result = await checkDependency(i, key, dependency);
    allChangelogList.push(result);

    await sleep(1000);
  }

  writeFiles(allChangelogList);
}

function getOutputDirectoryPath() {
  let result = "./reports/outdated-changelogs";

  const outputParamIndex = process.argv.findIndex((value) => value === "-o");
  if (outputParamIndex !== -1) {
    const outputParamValue = process.argv.slice(
      outputParamIndex + 1,
      outputParamIndex + 2
    )[0];

    result = outputParamValue || result;
  }

  return result;
}

// npm
// ===================

function readLockFile() {
  logMessage("read lock file");
  const rawdata = fs.readFileSync("package-lock.json");
  return JSON.parse(rawdata);
}

async function getOutdatedDependencies() {
  logMessage("get outdated dependencies");
  return new Promise((resolve, reject) => {
    childProcess.exec("npm outdated --json --long", (error, stdout) => {
      if (error && stdout.length === 0) {
        reject(error);
      } else {
        const response = JSON.parse(stdout || "{}");
        resolve(response);
      }
    });
  });
}

async function getRegistryInfos(
  homepageUrl,
  dependencyName,
  currentVersion,
  targetVersion
) {
  logInfo(`get infos for ${dependencyName}`);

  return new Promise((resolve, reject) => {
    const registryUrl = getRegistryUrl(dependencyName);
    request(registryUrl, { json: true }, (err, res, json) => {
      if (
        res &&
        res.statusCode < 300 &&
        json &&
        json["repository"] &&
        json["repository"]["url"] &&
        json["repository"]["url"].match(".*(github.com.*).git")
      ) {
        resolve({
          repoUrl: `https://${
            json["repository"]["url"].match(".*(github.com.*).git")[1]
          }`,
          currentVersionDate: json["time"][currentVersion],
          targetVersionDate: json["time"][targetVersion],
        });
      } else {
        reject(`Repository not found for ${homepageUrl}`);
      }
    });
  });
}

// retrieve data
// ===================

async function checkDependency(i, key, dependency) {
  const currentVersion = dependency["current"] || dependency["wanted"];
  const targetVersion = dependency["latest"];
  const homepageUrl = dependency["homepage"];
  let registryInfos;

  try {
    registryInfos = await getRegistryInfos(
      homepageUrl,
      key,
      currentVersion,
      targetVersion
    );
    const repoRawUrl = await getGithubRawUrl(registryInfos.repoUrl);
    const changelog = await loadChangelog(
      registryInfos,
      repoRawUrl,
      currentVersion
    );

    const result = formatChangelog(
      i,
      key,
      changelog,
      currentVersion,
      targetVersion,
      registryInfos.repoUrl
    );

    logSuccess(`✔ ${key} done`);
    return result;
  } catch (error) {
    const result = formatChangelog(
      i,
      `${key}`,
      "Changelog not found",
      currentVersion,
      targetVersion,
      registryInfos ? registryInfos.repoUrl : undefined
    );

    logError(`fail for ${key} with ${error}`);
    return result;
  }
}

async function loadChangelog(registryInfos, githubUrl, version, pos = 0) {
  const endpoints = ["CHANGELOG.md", "RELEASENOTES.md"];
  const url = `${githubUrl}${endpoints[pos]}`;
  logInfo(`get changelog at ${url} (v${version})`);

  return new Promise((resolve, reject) => {
    request(url, {}, (err, res, body) => {
      if (res && res.statusCode < 300) {
        resolve(body);
      } else {
        if (pos >= endpoints.length - 1) {
          reject(`Changelog not found for ${githubUrl}`);
        } else {
          loadChangelog(registryInfos, githubUrl, version, pos + 1)
            .then((content) => {
              resolve(content);
            })
            .catch((error) => {
              getCommits(registryInfos)
                .then((content) => {
                  resolve(content);
                })
                .catch((error) => {
                  reject(error);
                });
            });
        }
      }
    });
  });
}

async function getGithubRawUrl(url) {
  return new Promise((resolve, reject) => {
    if (isGithubUrl(url)) {
      let rawUrl = url;
      const anchorPos = url.indexOf("#");
      if (anchorPos !== -1) rawUrl = url.slice(0, anchorPos);
      rawUrl = rawUrl.replace(
        "https://github.com",
        "https://raw.githubusercontent.com"
      );
      resolve(`${rawUrl}/master/`);
    } else {
      reject("not a github repo");
    }
  });
}

function isGithubUrl(url) {
  return url.match("https://github.com") !== null;
}

function getRegistryUrl(dependencyName) {
  const url = lockFile["dependencies"][dependencyName]["resolved"] || "";
  const dashPos = url.indexOf("/-/");
  return url.slice(0, dashPos);
}

async function getCommits(registryInfos) {
  return new Promise((resolve, reject) => {
    const repoName = registryInfos.repoUrl.match(".*github.com/(.*)")[1];
    logInfo(`get commits for ${repoName}`);

    const url = `https://api.github.com/repos/${repoName}/commits?since=${registryInfos.currentVersionDate}&until=${registryInfos.targetVersionDate}`;
    request(
      url,
      { json: true, headers: { "User-Agent": "odc-1.0.1" } },
      (err, res, json) => {
        if (res && res.statusCode < 300 && json) {
          resolve(
            json
              .map(
                (res) =>
                  `• ${
                    res.commit.committer.date
                  } - ${res.commit.message.replace(/\\n/g, " | ")}`
              )
              .join("\n")
          );
        } else {
          reject(`Commit not found for ${repoName}`);
        }
      }
    );
  });
}

// template
// ===================

function executeTemplate(filePath, data = {}) {
  const template = fs.readFileSync(filePath, "utf8");
  const regex = /{{\s*(.+?)\s*}}/g;

  let output = template;
  while ((match = regex.exec(template))) {
    output = output.replace(match[0], eval(`data.${match[1]}`) || "");
  }

  return output;
}

function formatChangelog(
  id,
  dependencyName,
  content,
  currentVersion,
  targetVersion,
  url
) {
  const html = converter
    .makeHtml(content)
    .replace(/<pre><code/g, '<pre class="code"><code');

  return {
    id,
    url,
    name: dependencyName,
    filename: `${dependencyName}_${currentVersion}-${targetVersion}.html`.replace(
      /\//g,
      "-"
    ),
    content: html,
    version: {
      current: currentVersion,
      target: targetVersion,
      type: getUpgradeType(currentVersion, targetVersion),
    },
  };
}

function getUpgradeType(currentVersion = "", targetVersion = "") {
  const currentVersionComponents = currentVersion.split(".");
  const targetVersionComponents = targetVersion.split(".");

  function compare(i) {
    return (
      currentVersionComponents.length >= i + 1 &&
      targetVersionComponents.length >= i + 1 &&
      +targetVersionComponents[i] > +currentVersionComponents[i]
    );
  }

  if (currentVersion === targetVersion) return "latest";
  else if (compare(0)) return "major";
  else if (compare(1)) return "minor";
  else if (compare(2)) return "fix";
  else return "unknow";
}

function writeFiles(allChangelogList) {
  console.log(``);
  logMessage(`=====================`);

  fs.copyFileSync(
    `${staticDirectory}/index.css`,
    `${outputDirectory}/index.css`
  );

  for (const changelogData of allChangelogList) {
    logMessage(`write ${changelogData.filename}`);

    let nav = "";
    for (const navData of allChangelogList) {
      nav += executeTemplate(`${staticDirectory}/nav-template.html`, {
        changelog: navData,
        selectedClass: navData.name === changelogData.name ? "selected" : "",
      });
    }

    const html = executeTemplate(`${staticDirectory}/main-template.html`, {
      nav: nav,
      changelog: changelogData,
    });

    fs.writeFileSync(`${outputDirectory}/${changelogData.filename}`, html);
  }

  console.log("");
  logSuccess(
    `${allChangelogList.length} changelog${
      allChangelogList.length > 1 ? "s" : ""
    } available in ${outputDirectory}`
  );
  logSuccess(`Ready ! 🚀`);
}

// Helpers
// ===================

function logInfo(message) {
  console.log(`\x1b[30m`, `[changelog] ${message}`);
}

function logMessage(message) {
  console.log(`\x1b[36m`, `[changelog] ${message}`);
}

function logSuccess(message) {
  console.log(`\x1b[32m`, `[changelog] ${message}`);
}

function logError(message) {
  console.error(`[changelog] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearOutputDirectory() {
  logMessage(`clear output directory ${outputDirectory}`);
  rimraf.sync(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
}
