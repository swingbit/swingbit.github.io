---
layout: post
title: How many lindy hoppers are there in the world?
date: 2015-10-08
tags: swing facebook
---

*(UPDATE: The procedure described in this post is no longer viable due to the restrictions Facebook has imposed to the use of its Graph API.)*

How many lindy hop dancers are out there?

I believe there is no real good method to answer this very question. Partly because it is too broad (how do we define a "lindy hopper"?), partly because it is objectively impossible to get complete and up to date data.

[One interesting previous approach](http://lindypenguin.com/wp/2014/06/how-many-lindy-hoppers-are-there.html?fbclid=IwAR2gUxr9BY66NA6dXCSbQTqpGGB7eTFIofQ2c8lqaHXwLnOQqKBXy-Yq5Us), dated July 2014, estimates the total number to be between 82,000 and 153,000. This approach is based on a Monte Carlo simulation, starting from a number of assumptions.


# The approach I chose

I chose to try and get some real data from Facebook, and make the following assumptions:

Most lindy hoppers are on Facebook.
Everyone who is member of a relevant (about lindy hop) group, page, event, is or has been a lindy hopper 

The goal is to collect data with [precision in mind rather than recall](https://en.wikipedia.org/wiki/Precision_and_recall?fbclid=IwAR0R2nCePx9yFKPmkS5X0S5c-0hOzqg7MztrvlwhSYb2k0WPRXdaYcJ7wxk).
That is, we put emphasis on “there are at least X  lindy hoppers”, rather than “up to X lindy hoppers”.
We do this by exploring public Facebook data as precisely as possible and accepting that we may miss results.

Facebook users, groups, events, posts, etc. are organised as nodes in a large graph. An edge of type "member" connects my user account to the each of the groups I am a member of. Friendship edges connect users, and so on.
Facebook provides a [Graph API](https://developers.facebook.com/docs/graph-api) that can be used to retrieve data from this graph.

 
Now that we have a tool to retrieve data, all we need is a little script to:

- get a list of groups, pages, events that are about Lindy Hop
- for each such "containers" retrieve the list of users that are connected to it
- put together all users so obtained, removing duplicates (each lindy hopper is likely to be in several groups / events)
 

A few technical details: The scripting is done in Bash, using cURL to call the REST version of the Graph API. 
To be able to use the Graph API, one needs to sign up at https://developers.facebook.com/ and obtain an access token that needs to be specified in each API request.
So don’t be surprised if clicking the links show here yields an authentication error.
In my first attempt, Facebook blocked me because I was issuing my request at a too high speed. I later found out that the limit is 1 request per second (actually measured as 600 requests per 600 seconds).

# How to get a list of relevant containers?

The list of Facebook groups / pages / events that are about lindy hop is definitely large. We are not going to get an exhaustive list, but we are trying to get as close as possible to that. Most importantly, we are trying to get a list that is as noiseless as possible (few false-positives).

 

The first Graph API functionality that we are using for this is a standard keyword search. Keyword search is powerful, but the risk of retrieving too many false-positives is high. Therefore, I decided to limit the search to only 2 keywords: lindy and swing. Most lindy hop groups / events do contain such keywords. The API performs a fuzzy match: the keyword lindy will also match "lindyhop" spelled as one word.

Search for groups containing lindy or swing:
```
graph.facebook.com/v2.4/search?q=lindy&type=group
graph.facebook.com/v2.4/search?q=swing&type=group
```

Search for events containing lindy or swing: 
```
graph.facebook.com/v2.4/search?q=lindy&type=event
graph.facebook.com/v2.4/search?q=swing&type=event
``` 

Note: unfortunately the API does not allow OR and NOT expressions in one call (all keywords must appear). That's why we need one call per keyword to implement an OR logic. 

When searching groups, only the OPEN groups were selected, as CLOSED or SECRET group do not allow to retrieve the list of their members.
It is also possible to find pages. However, it is not possible, once obtained the pages, to find the users who "liked" them.
These graph edges are only available  from users to pages, not the other way around. So we don’t consider pages at all.

The total number of containers found was: 563 groups and 739 events.

# Were the containers found actually relevant?

The list of containers obtained from the above calls does contain quite some false-positive. While the keyword "lindy" is rather specific, the keyword "swing" is rather generic and can be used in different contexts. For example, it can be used for swing music, or west coast swing (which I decided to exclude).
I processed the lists of groups and events, partly automatically, partly manually to remove the false-positives. The accuracy of this list is more important than its length.

 

These are the rules I have applied:

- It needs to be about dancing, not about music. No concerts, bands, etc.
- It needs to be about lindy hop. No west coast swing, balboa, blues, boogie, electroswing, latino, etc.
- Groups / events that are about lindy hop but also about other dances are excluded. Adding a group about "lindy hop and blues" risks to add blues dancers to the final count. This is not the goal.
 

Here a few random examples of false-positives:

```
Dance SWING! Dance ROCKABILLY! 
Dance BOOGIE!Electro Swing, Lindy Hop & Burlesque in Köln
Lindy Hop Swing & Tango la Iasi cu Raul Navalpotro
The Swing it Orchestra
``` 

Applying these restrictions leaves us with: 511 groups and 340 events.


I also added a small list of sure-positives that were not found by my simple keyword search, just because their name is cooler than the others (no lindy / swing in it). Examples are “Frankie 100” or “Snowball”. We definitely want to add those. However, I have put very little effort in this. Feel free to send me other sure-positives to add.

Each node in the Facebook graph (users, groups, events, posts, etc.) is identified by a unique numeric ID. 
We can use this ID to make more queries. In this case we ask for group members and event invitees.

For each group, we ask for the list of members:
```
graph.facebook.com/v2.4/<GROUP ID>/members
```

For each event, we ask for the list of invitees, which are split in 4 different RSVP categories:
```
graph.facebook.com/v2.4/<EVENT ID>/attending
graph.facebook.com/v2.4/<EVENT ID>/maybe
graph.facebook.com/v2.4/<EVENT ID>/declined
graph.facebook.com/v2.4/<EVENT ID>/noreply
``` 

Now that we have a list of users from each of these buckets (their ID actually, we are not interested in their name, which I didn’t store), we have to merge them and remove duplicates. Duplicate removal is essential, because most lindy hoppers join multiple events and groups.

# What can be improved?
 

The current estimation can of course be improved. Some of my own thoughts and some coming from comments:

- **Are fake user profiles being counted?**
It isn’t easy to detect fake user profiles programmatically.
One fairly reliable way would be to count the number of friends of the account. Usually fake profiles have no or very few friends. However, most users’ privacy settings don’t allow to get such details.
What I’m thinking to do is to manually evaluate a sample, then extrapolate an estimate on the total count, together with a statistical significance.
- **Are you counting only active dancers or everyone? / Does the engagement in Facebook reflect actual engagement in real life?**
The example that comes to mind is someone signing up to an event for a drop-in class, but never actually showing up. 
Or, someone who never comes back after a first class. Somewhere above I stated that I’m counting whoever “is or has been” a lindy hopper.
That is, my focus was not necessarily on active dancers (good luck anyway with defining “active”). Students with low or non-recent activity are also counted in principle.
However, as a side-effect of the method used, we end up with pretty recent data, because past events are not found by the initial keyword search.
Still, it could be nice to be able to focus a little more, if not on the really active dancers, at least on the somewhat decently active dancers. 
Ben Beccari suggested to filter out users who appear in only 1 of the events considered. These may be either wanted-to-be dancers or fake profiles. I’m not sure yet if this is true, but I’d like to try this out.
- **What about languages / alphabets different from English / Latin?**
Luckily “lindy” and “swing” are international. Still, they could be spelled with different alphabets. 
A safe assumption (with the goal of focusing a lower bound of the estimate) is that the keywords would be spelled with a Latin alphabet anyway. 
Sometimes this is actually the case (e.g. “SWING DANCE　▎松菸木板地”). In other cases, we would need to search with different alphabets altogether, or no results would be found. The search itself would not be the main challenge though. Rather, the work needed to manually go through the list of results to spot false-positives. That is something I could not do myself.

# So, what is the total?

The number of distinct user IDs found this way on 8 October 2015 is.....
<p style="text-align: center; font-size: x-large">
> 353,871
</p>

Remember that the goal of this approach was to estimate a lower bound to the real number. 
My wild guess is that the real number is easily closer to twice as much (whatever the number above may be updated to), because:
 a) my basic keyword search may have missed many groups / events;
 b) many groups / events are not public;
 c) past events are not found by the keyword search;
 d) pages cannot be used;
 e) groups / events that use a non-Latin alphabet and have no English text are left out. See section above about possible improvements.

