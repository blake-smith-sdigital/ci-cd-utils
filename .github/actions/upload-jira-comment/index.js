import * as core from '@actions/core';
import * as github from '@actions/github';
import FormData from 'form-data';
import fetch from 'node-fetch';
import fs from 'fs';


// UTIL FUNCTIONS * * * * * * * * * * * *
const formatDescription = (description) => {
  const markdown = description.replace(
    /<img\b[^>]*\balt="([^"]*)"[^>]*\bsrc="([^"]*)"[^>]*\/?>|<img\b[^>]*\bsrc="([^"]*)"[^>]*\balt="([^"]*)"[^>]*\/?>/gi,
    (match, alt1, src1, src2, alt2) => {
      const alt = alt1 || alt2 || '';
      const src = src1 || src2 || '';
      // return `![${alt}](${src})`; // TODO bs
      return `![${alt}]`; // Reference image name after uploading as attachment
    }
  );

  return markdown;
}

const extractImageTags = (text) => {
  // This regex matches <img ...> tags, including those with various attributes and spacing
  const imgTagRegex = /<img\b[^>]*src=["'][^"']+["'][^>]*>/gi;
  const matches = text.match(imgTagRegex);
  // Return the array of img tags, or an empty array if none found
  return matches || [];
}

async function run() {
  try {
    const pullRequestInput = core.getInput('pull_request'); // Returns a string
    const pullRequest = pullRequestInput ? JSON.parse(pullRequestInput) : null;
    const jiraBaseUrl = core.getInput('jira_base_url');
    const jiraApiToken = core.getInput('jira_api_token');
    const jiraUserEmail = core.getInput('jira_user_email');
    const prDescription = pullRequest.body || '';
              
    if (!pullRequestInput) {
      core.info('No pull request found, skipping.');
      return;
    }

    console.log(`PR description: ${prDescription}`); // TODO bs
    
    if (!prDescription.trim()) {
      core.info('PR description is empty, skipping.');
      return;
    }
    
    // Log info that we are processing
    core.info('Processing PR description...');
    
    let ticketNumber = null;
    const mediaFiles = extractImageTags(prDescription); // Gather all img tags to upload as attachments

    // Get ticker number from branchname
    if (pullRequest.head && pullRequest.head.ref) {
      const branchName = pullRequest.head.ref;
      const branchTicketNumberMatch = branchName.match(/(SCOM-\d+)/);

      console.log(`Branch name: ${branchTicketNumberMatch}`); // TODO bs

      if (branchTicketNumberMatch && branchTicketNumberMatch[1]) {
        ticketNumber = branchTicketNumberMatch[1];
        core.info(`Found Jira Number: ${branchTicketNumberMatch[1]}`);
      }
    }

    // Only use ticket numbers from branch name
    console.log(`Ticket number: ${ticketNumber}`); // TODO bs
    if (!ticketNumber) {
      core.info('No Jira ticket key found in branch name, skipping.');
      return;
    }

    const authString = `${jiraUserEmail}:${jiraApiToken}`;
    const encodedAuth = Buffer.from(authString).toString('base64');

    const headers = {
      'Authorization': `Basic ${encodedAuth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    async function uploadMediaAttachments() {
      const url = `${jiraBaseUrl}/rest/api/3/issue/${ticketNumber}/attachments`;
      const formData = new FormData();
    
      console.log('^ ^ ^ ^ mediaFiles ', mediaFiles)

      for (const imgTag of mediaFiles) {
        // Extract src and alt attributes
        const srcMatch = imgTag.match(/src="([^"]+)"/);
        const altMatch = imgTag.match(/alt="([^"]*)"/);
        if (!srcMatch) continue; // Skip if no src found
    
        const imageUrl = srcMatch[1];
        const altText = altMatch ? altMatch[1].replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'attachment';
    
        try {
          // Download image as Buffer (using node-fetch)
          const imageResponse = await fetch(imageUrl);
          if (!imageResponse.ok) {
            core.error(`Failed to download image from ${imageUrl}: ${imageResponse.status} - ${imageResponse.statusText}`);
            continue;
          }
          const imageBuffer = await imageResponse.arrayBuffer(); // Get as ArrayBuffer
          const buffer = Buffer.from(imageBuffer); // Convert to Node.js Buffer
    
          // Append to FormData (Jira expects 'file' as the field name)
          formData.append('file', buffer, { filename: `${altText || 'attachment'}.png` });
          console.log('FORM DATA inside loop:', formData); // Debug: Log inside the loop
        } catch (error) {
          core.error(`Error processing image ${imageUrl}: ${error.message}`);
          continue; // Skip to the next image
        }
      }
    
      // Debug: Log FormData before fetch (may not show full content)
      console.log('FORM DATA before fetch:', formData);
    
      const fetchOptions = {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${encodedAuth}`,
          'X-Atlassian-Token': 'no-check',
        },
        body: formData,
      };
    
      // Debug: Log fetch options
      console.log('Fetch options:', fetchOptions);
    
      try {
        const response = await fetch(url, fetchOptions);
    
        if (!response.ok) {
          const errorBody = await response.text();
          core.error(`Failed to upload media attachments: ${response.status} - ${response.statusText}`);
          core.error(errorBody);
        } else {
          core.info(`Successfully uploaded media attachments to Jira ticket: ${ticketNumber}`);
        }
      } catch (error) {
        core.error(`Failed to upload media attachments: ${error.message}`);
      }
    }

    async function uploadCommentToJira(ticketKey, commentBody) {
      const jiraCommentUrl = `${jiraBaseUrl}/rest/api/3/issue/${ticketKey}/comment`;
      
      // Format the comment to be more useful
      const prLink = pullRequest.html_url;
      const prTitle = pullRequest.title;
      const prNumber = pullRequest.number;
      const prStatus = pullRequest.merged ? 'merged' : 'closed';
      
      const jiraComment = `*PR #${prNumber}: "${prTitle}" was ${prStatus}*\n\n${commentBody}\n\n[View PR on GitHub|${prLink}]`;
      
      const jiraCommentPayload = {
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: jiraComment,
                },
              ],
            },
          ],
        },
      };

      try {
        const response = await fetch(jiraCommentUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(jiraCommentPayload),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          core.error(`Failed to add comment to Jira ticket ${ticketKey}: ${response.status} - ${response.statusText}`);
          core.error(errorBody);
          core.setOutput('jira_comment_uploaded', 'false');
        } else {
          core.info(`Successfully added comment to Jira ticket: ${ticketKey}`);
          core.setOutput('jira_comment_uploaded', 'true');
        }
      } catch (error) {
        core.error(`Failed to add comment to Jira ticket ${ticketKey}: ${error.message}`);
        core.setOutput('jira_comment_uploaded', 'false');
      }
    }
    
    const finalDescription = formatDescription(prDescription);

    // Finally upload to Jira
    await uploadMediaAttachments();
    await uploadCommentToJira(ticketNumber, finalDescription);

  } catch (error) {
    core.setFailed(`An error occurred in the custom action: ${error.message}`);
    core.setOutput('jira_comment_uploaded', 'false');
  }
}

run();