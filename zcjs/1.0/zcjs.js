//Library class
class ZCJS {
  constructor(target) {
    this._target = document.getElementById(target);
    if (target === undefined) {
      this.plotMethod = null;
    } else {
      this.plotMethod = "plotly";
    }
    this.stats = true;
    this._version = 1.0;
    this._fileVendor = null;
    this._fileVendorVersion = null;
    this.x_range = "ms";
    this.y_range = "nonzero";
    this.y_fixed = true;
    this.x_compress = false;
  }

  setURL(newfile) {
    this._url= newfile;
    this._source = "url";
    this.process_url();
  }

  setData(time, freq) {
    this._time = time;
    this._freq = freq;
    if (this.x_compress) { this.do_x_compress(); };
    if (this.plotMethod != null) { this.plotZC(); };
  }

  do_x_compress() {
    var cutoff = 0.001;
    if (Array.isArray(this.y_range)) {
      cutoff =this.y_range[0];
    }
    this._c_time = [];
    this._c_freq = [];
    this._c_time_orig = [];

    var compressed_time = 0;
    var instance = this;

    this._freq.forEach(function(item, index) {
      if (item > cutoff) {
        instance._c_freq.push(instance._freq[index]);
        instance._c_time.push(compressed_time);
        instance._c_time_orig.push(instance._time[index]);
        compressed_time += instance._time[index] - instance._time[index - 1];
      }
    });
  }

  process_url() {
    var instance = this;
    var req = new XMLHttpRequest();
    req.open("GET", this._url, true);
    req.responseType = "arraybuffer";
    req.onload = function (event) {
      var arrayBuffer = req.response;
      if (arrayBuffer) {
        instance._fileRawData = new Uint8Array(arrayBuffer);
        instance.identifyFile();
        if (instance._fileVendor == "Anabat") {
          var data = instance.readAnabat();
          data.timeData = data.timeData.map(function(element){return element/1000000;});
          instance.setData(data.timeData, data.frequencyData);
        }
      }
    }
    req.send();
  }

  anabatHeader() {
    var head = this._fileRawData.slice(6,281);
    var str = '';
    for (var i = 0; i < head.length; i++) {
      str += '%' + ('0' + head[i].toString(16)).slice(-2);
    }
    str = decodeURIComponent(str);
    var ret = {
      tape:    str.substring(0,8),
      date:    str.substring(8,16),
      loc:     str.substring(16,56),
      species: str.substring(56,106),
      spec:    str.substring(106,122),
      note:    str.substring(122,196),
      note1:   str.substring(196,275)
    }
    return(ret);
  }

  plotZC() {
    if (this.plotMethod == "plotly") {this.plotPlotly();}
  }

  plotPlotly() {
    var zcplot = this._target;
    var plot_width = zcplot.clientWidth;
    var y_range_min = Math.min.apply(null, this._freq.filter(Boolean));
    var y_range_max = Math.max.apply(Math, this._freq);

    var plotly_x_axis = {};
    var plotly_y_axis = {};

    if (this.x_range == "ms") {
     plotly_x_axis = {range: [0, 90/plot_width]};
    }
    if (Array.isArray(this.x_range)) {
      plotly_x_axis = {range: [this.x_range[0], this.x_range[1]]};
    }
    if (this.y_range == "nonzero") {
      plotly_y_axis = {fixedrange:this.y_fixed, range: [y_range_min, y_range_max]};
    }
    if (Array.isArray(this.y_range)) {
      plotly_y_axis = {fixedrange:this.y_fixed, range: [this.y_range[0], this.y_range[1]]};
    }

    Plotly.newPlot( zcplot,
        [{
           x: this.x_compress ? this._c_time : this._time,
           y: this.x_compress ? this._c_freq : this._freq,
           type: 'scatter',
           mode: 'markers',
           marker: {size: 3}
        }],
        {
          margin: { t: 0 },
          xaxis: plotly_x_axis,
          yaxis: plotly_y_axis
        }
    );
  }

  identifyFile() {
    var check_anabat = this._fileRawData[3];
    var anabats = [129, 130, 131, 132];
    if (anabats.includes(check_anabat)) {
      this._fileVendor = "Anabat";
      this._fileVendorVersion = check_anabat;
    }
  }

  readAnabat() {
    var parameterPoint = this._fileRawData[0] + 256 * this._fileRawData[1];
    var params = this.getParams(parameterPoint);
    var dataPoint  = this._fileRawData[parameterPoint] + 256 * this._fileRawData[parameterPoint + 1] - 1;
    var timeResult = null;
    if (this._fileVendorVersion == 129) {
      timeResult = this.getData129(dataPoint, params, this._fileRawData);
    } else {
      timeResult = this.getData130(dataPoint, params, this._fileVendorVersion, this._fileRawData);
    }

    var freqResult = this.calcfreq(params, timeResult.timeData, timeResult.last_t);
    var freq = freqResult.freq;
    var showDot = freqResult.showDot;

    //TODO: need badPts?

    var data = {
      frequencyData: freq,
      showDot: showDot,
      timeData: timeResult.timeData
    };
    return(data);
  }

  getParams(parameterPoint) {
    var RES1 = this._fileRawData[parameterPoint + 2] + 256 * this._fileRawData[parameterPoint + 3];
    var timeFactor = 1;
    if (RES1 != 25000) {
      timeFactor = 25000/RES1;
    }
    var DIVRAT = this._fileRawData[parameterPoint + 4];
    var VRES = this._fileRawData[parameterPoint + 5];
    var params = {
      RES1: RES1,
      DIVRAT: DIVRAT,
      VRES: VRES,
      timeFactor: timeFactor
    };
    return(params);
  }

  getData129(dataPoint, params) {
    //TODO
  }

  getData130(dataPoint, params) {
    var p = dataPoint;
    var time = 0;
    var dif = 0;
    var lastdiff = 0;
    var t = 1;
    var s = 0;
    var timeData = [];
    var showDot = new Array(0,1);
    var nBytes = this._fileRawData.length;
  
    if ((params.RES1 > 60000) || (params.RES1 < 10000)) { return(null); }
  
    while ((p < nBytes) && (t <  16384)) {
      if (this._fileRawData[p] < 128) {
        dif = this._fileRawData[p];
        if (dif > 63) { dif = -1*(ZCJS.bitFlip(dif,6) + 1); }
        lastdiff = lastdiff + dif;
        time = time + Math.floor(params.timeFactor * lastdiff + 0.5);
        timeData.push(time);
        t++;
        p++;
      } else {
        if (this._fileRawData[p] >= 224) {
          if (this._fileVendorVersion > 130) {
            if (p >= nBytes) {break;}
            var c = this._fileRawData[p] & 3;
            s = this._fileRawData[p+1];
            if ((t+s-1) > 16384) { s=16384 - t;}
            for (var i = t; i < t+s; i++) {
              showDot[i]=c;
            }
            p += 2;
          } else {
            //TODO: Filetype 130
          }
        } else {
          if ((128 <= this._fileRawData[p]) && (this._fileRawData[p] <= 159)) {
            if ((p+1) >= nBytes) {break; }
            dif = 256 * (this._fileRawData[p] & 31) + this._fileRawData[p+1];
            lastdiff = dif;
            time = time+ Math.floor(params.timeFactor*lastdiff + 0.5);
            timeData.push(time);
            t++;
            p += 2;
          } else {
            if ((160 <= this._fileRawData[p]) && (this._fileRawData[p] <= 191)) {
              if ((p+2) >= nBytes) {break; }
              dif = 256*256*(this._fileRawData[p] & 31) + 256*this._fileRawData[p+1] + this._fileRawData[p+2];
              lastdiff  = dif;
              time = time + Math.floor(params.timeFactor*lastdiff + 0.5);
              timeData.push(time);
              t++;
              p += 3;
            } else {
              if ((192 <= this._fileRawData[p]) && (this._fileRawData[p] <= 239)) {
                if ((p+3) >= nBytes) {break; }
                dif = 256*256*256*(this._fileRawData[p] & 31) + 256*256*this._fileRawData[p+1] + 256*this._fileRawData[p+2] + this._fileRawData[p+3];
                lastdiff = dif;
                time = time + Math.floor(params.timeFactor*lastdiff + 0.5);
                timeData.push(time);
                t++;
                p += 4;
              }
            }
          }
        }
      }
    }
    var ret = {
      timeData: timeData,
      last_t: t,
      showDot: showDot
    };
    return(ret);
  }

  static bitFlip(v, digits) {
    return ~v & (Math.pow(2, digits) - 1);
  }

  calcfreq(params, timeData, N) {
    var DIVRAT = params.DIVRAT;
    var freq = Array(0,0);
    var showDot = Array(0,1);
    var t = 2;

    var Tmin = Math.ceil(DIVRAT*4);
    var Tmax = Math.floor(DIVRAT*250);
    if (Tmin < 48) { Tmin = 48;}
    if (Tmax > 12589) { Tmax = 12589; }

    while (t <= N) {
      var td = timeData[t] - timeData[t-2];
      if ((td >= Tmin) && (td <= Tmax)) {
        freq.push(Math.trunc(DIVRAT*1000000/td));
        showDot.push(2);
      } else {
        freq.push(0);
        showDot.push(0);
      }
      t++;
    }
    var ret = {
      freq:freq,
      showDot:showDot
    };
    return(ret);
  }
};
