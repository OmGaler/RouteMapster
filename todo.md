### TODO: Stop Centrality
### Resizable sidebars
todo: advance stop analysis - prevent overflow and also when opening card
todo: advance stop analysis - remove all stops/ stops with routes (redundant)
remove mds from gh ...


show all digits
e.g. 40 140 240 340 440 .. 
---
To check (at some point):

- update the PVR/%age is updated


not all 24hr routes are shown as night routes too - see for instance 14 @ RA


doesnt show prefix routes when show all is on 
make sure stops are always on top of routes

shortcuts - 
G - garage view
S - stops
S ?? - station

R -
0 - 24hr?, P- prefix - N - night


<!-- todo: -->
make loader modal bigger 

clicking/hovering bus stations stops working as expected after first interaction


change main routes to reg. routes 

<!-- todo --> 
ash grove (hk) doesnt exist
: Edgware (BT) shows twice
check brixton BN bus garage
cromwell road bus station, incorrect routes
83
weird school routes eg 163
ash grove incorrectly infers existence of 550 from N550, same for 118

bus station/garage clicking weirdness...
. When a route filter is added, the route(s) should display - even if show all routes is off.
2. Hovering over a road shows a popup with the route pills. Clicking on the route geometry should open a sidebar with the same info. Also add to both the name of the road
3. Whenever a popup of route pills is shown - fix the styling so that it wraps and keeps the popup to pleasing dimensions, not all in one or two columns if it makes it really long and thin
Frequencies- 
The current setup is much too complex - I want data to be as simple as humanely possible- e.g. 
{"1": ["peak am": 6, "offpeak": 2, "peak pm": 5, "overnight": 0], "C1 ": etc...
In bph I should think 
Im sure you'll agree my current data is much to convouted and not readable.

<!-- todo -->
colour routes by type should apply to filtered routes too
169 and w13 shouldnt be school routes

<!-- todo: -->
operator name in garage - <br> etc...

<!-- Todo: -->
Write tests:
<!-- todo -->
optimisation


Check data works
bus stands broken - probably not available in the tfl api :/


give sd/dd to newly introduced routes??

Night routes freqs are zero??

colour routes by type should apply to filtered routes too..??

preprocess data - remove uneeded garabage from garages.geojson, when updating data only touch routes, not postcode or location

filter routes by postcode/borough- possibly more than one, e.g. all routes in NW4,NW2

bus stops.geojson

GH actions -

notify with any changes - e.g. added route N118, removed route 283
    or 96 moved from DF to W