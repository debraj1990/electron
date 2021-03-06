#!/usr/bin/env node

if (!process.env.CI) require('dotenv-safe').load()
require('colors')
const pass = '\u2713'.green
const fail = '\u2717'.red
const args = require('minimist')(process.argv.slice(2), {
  string: ['tag', 'releaseId'],
  default: { releaseId: '' }
})
const { execSync } = require('child_process')
const { GitProcess } = require('dugite')

const GitHub = require('github')
const path = require('path')

const github = new GitHub()
const gitDir = path.resolve(__dirname, '..')

github.authenticate({
  type: 'token',
  token: process.env.ELECTRON_GITHUB_TOKEN
})

function getLastBumpCommit (tag) {
  const data = execSync(`git log -n1 --grep "Bump ${tag}" --format='format:{"hash": "%H", "message": "%s"}'`).toString()
  return JSON.parse(data)
}

async function getCurrentBranch (gitDir) {
  const gitArgs = ['rev-parse', '--abbrev-ref', 'HEAD']
  const branchDetails = await GitProcess.exec(gitArgs, gitDir)
  if (branchDetails.exitCode === 0) {
    return branchDetails.stdout.trim()
  }

  const error = GitProcess.parseError(branchDetails.stderr)
  console.error(`${fail} couldn't get current branch: `, error)
  process.exit(1)
}

async function revertBumpCommit (tag) {
  const branch = await getCurrentBranch()
  const commitToRevert = getLastBumpCommit(tag).hash
  await GitProcess.exec(['revert', commitToRevert], gitDir)
  const pushDetails = await GitProcess.exec(['push', 'origin', `HEAD:${branch}`, '--follow-tags'], gitDir)
  if (pushDetails.exitCode === 0) {
    console.log(`${pass} successfully reverted release commit.`)
  } else {
    const error = GitProcess.parseError(pushDetails.stderr)
    console.error(`${fail} could not push release commit: `, error)
    process.exit(1)
  }
}

async function deleteDraft (releaseId, targetRepo) {
  try {
    const result = await github.repos.getRelease({
      owner: 'electron',
      repo: targetRepo,
      id: parseInt(releaseId, 10)
    })
    console.log(result)
    if (!result.draft) {
      console.log(`${fail} published releases cannot be deleted.`)
      return false
    } else {
      await github.repos.deleteRelease({
        owner: 'electron',
        repo: targetRepo,
        release_id: result.id
      })
    }
    console.log(`${pass} successfully deleted draft with id ${releaseId} from ${targetRepo}`)
    return true
  } catch (err) {
    console.error(`${fail} couldn't delete draft with id ${releaseId} from ${targetRepo}: `, err)
    return false
  }
}

async function deleteTag (tag, targetRepo) {
  try {
    await github.gitdata.deleteReference({
      owner: 'electron',
      repo: targetRepo,
      ref: tag
    })
    console.log(`${pass} successfully deleted tag ${tag} from ${targetRepo}`)
  } catch (err) {
    console.log(`${fail} couldn't delete tag ${tag} from ${targetRepo}: `, err)
  }
}

async function cleanReleaseArtifacts () {
  const releaseId = args.releaseId.length > 0 ? args.releaseId : null
  const isNightly = args.tag.includes('nightly')

  if (releaseId) {
    if (isNightly) {
      const deletedNightlyDraft = await deleteDraft(releaseId, 'nightlies')
      // don't delete tag unless draft deleted successfully
      if (deletedNightlyDraft) {
        await Promise.all([
          deleteTag(args.tag, 'electron'),
          deleteTag(args.tag, 'nightlies')
        ])
      }
    } else {
      const deletedElectronDraft = await deleteDraft(releaseId, 'electron')
      // don't delete tag unless draft deleted successfully
      if (deletedElectronDraft) {
        await deleteTag(args.tag, 'electron')
      }
    }
  }

  // try to revert commit regardless of tag and draft deletion status
  await revertBumpCommit(args.tag)

  console.log(`${pass} failed release artifact cleanup complete`)
}

cleanReleaseArtifacts()
