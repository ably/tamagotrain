const Ably = require('ably/promises');
const nothing = () => { };

const defaultWaitTime = 12000;
const trainIdleTimeCap = 30000;

class AblyTrainArrivalsClient {
  constructor(client) {
    console.log("AblyTrainArrivalsClient created.");
    this._timetableAgeInMs = 0;
    this._client = client || new Ably.Realtime({ authUrl: '/api/createTokenRequest' });
    this._callback = nothing;
    this._pollingIntervalMs = 250;
    this._channel = null
  }
  
  async listenForEvents(id, callback) { 
    this._callback = callback || nothing;
    this.subscribeToLine(id);
    const currentClient = this;
    setInterval(function (){ currentClient.dispatchAnyMessagesDue() }, this._pollingIntervalMs);
 }  
  
  stopListening() {
    if (this._channel) {
      this._channel.unsubscribe(this.timetableUpdated); 
    }
  }
  
  async subscribeToLine(id) {
    const channelId = `[product:ably-tfl/tube]tube:${id}:arrivals`;
    this._channel = await this._client.channels.get(channelId);
    await this._channel.attach();

    const resultPage = await this._channel.history({ untilAttach: true, limit: 1 });       
    this.timetableUpdated(resultPage.items[0]);
    const currentClient = this;
    this._channel.subscribe(function(msg) { currentClient.timetableUpdated(msg); }); 
  }
  
  timetableUpdated(message) {    
    const mergedTimetableData = this.mergeTrainTimetables(message);   
    
    this._timetable = { 
      setAt: Date.now(),
      // data: message.data
      data: mergedTimetableData
    };
    
    this._timetableAgeInMs = 0;
    console.log("Updated this._timetable", this._timetable);
    console.log("Next train due in ", this._timetable.data[0].TimeToStation);    
  }
  
  
  dispatchAnyMessagesDue() {    
    this._timetableAgeInMs += this._pollingIntervalMs;    
    
    if (!this._timetable) {
      return;
    }
    

    if (this._timetable.setAt !== this._lastDispatchSetAt) {
      console.log("Timetable updated since last dispatch");
    }
    
    this._lastDispatchSetAt = this._timetable.setAt;    
    
    for (const [ index, item ] of this._timetable.data.entries()) {
      const itemAgeMs = item.TimeToStation * 1000;

      if (itemAgeMs > this._timetableAgeInMs) {
        continue;
      }
      
      console.log("Train from timetable reached arrival.", this._timetable.setAt, item);

      // Work out when to raise a departure message
      const thereAreMoreTrains = this._timetable.data.length > index + 1;
      
      const nextTrainHalflife = thereAreMoreTrains
                      ? this.getNextTrain(index).TimeToStation * 1000 / 2
                      : defaultWaitTime;
      
      const departsInMs = nextTrainHalflife > trainIdleTimeCap ? trainIdleTimeCap : nextTrainHalflife;

      console.log("Scheduling departure for " + departsInMs + " from now.");
      
      this.raiseMessagesFor(item, departsInMs);
      item.completed = true;
    }
    
    this._timetable.data = this._timetable.data.filter(i => !i.completed);     
  }
  
  getNextTrain(index) {
    return this._timetable.data[index + 1];
  }
  
  mergeTrainTimetables(ablyResponse) {
    const allLines = Object.getOwnPropertyNames(ablyResponse.data);

    let allTrains = [];      
    for (let lineName of allLines) {
      const arrayOfTrains = ablyResponse.data[lineName];        
      allTrains = allTrains.concat(arrayOfTrains);
    }

    return allTrains.sort((a, b) => a.TimeToStation - b.TimeToStation);
  }
  
  raiseMessagesFor(item, departsInMs) {

    this._callback({ 
      line: "platformId1", 
      arrived: true,
      source: this.constructor.name, 
      sourceMessage: item,
      departsInMs: departsInMs
    });

    setTimeout(() => {

       this._callback({ 
         line: "platformId1", 
         departed: true, 
         source: this.constructor.name, 
         sourceMessage: item
        });

    }, departsInMs);  
  } 
  
}

module.exports = AblyTrainArrivalsClient;