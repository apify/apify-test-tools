reponame=$(jq '.repository.name' ${GITHUB_EVENT_PATH})
commit_message=$(jq '.head_commit.message' ${GITHUB_EVENT_PATH})
pr_title=$(jq '.pull_request.title' ${GITHUB_EVENT_PATH})

if [ "${commit_message}" != "null" ]; then
    echo "Received push event from repo ${reponame} with commit message ${commit_message}"
    fi

if [ "${pr_title}" != "null" ]; then
    echo "Received PR event from repo ${reponame} with PR title ${pr_title}"
    fi
