var generateTabulator = function(element, table) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "https://api.audioblast.org/data/"+table+"/columns/?output=nakedJSON", true);
  xhr.extraInfo = [element, table];
  xhr.onload = function (e) {
    if (xhr.readyState === 4) {
      if (xhr.status === 200) {
        var table = this.extraInfo[1];
        var element = this.extraInfo[0];
        var cols = JSON.parse(this.responseText);
        var ajaxURL = 'https://api.audioblast.org/data/'+table+'/';
        var tabletabulator = new Tabulator(element, {
           columns:parseColumns(cols),
           height:"100%",           
           ajaxURL:ajaxURL,
           progressiveLoad:"scroll",
           filterMode:"remote",
           paginationSize:50,
           dataSendParams:{
             "size":"page_size",
           }
        });
      } else {
        console.error(xhr.statusText);
      }
    }
  };
  xhr.onerror = function (e) {
    console.error(xhr.statusText);
  };
  xhr.send(null);
}

var generateAnalysisTabulator = function(element, table, source, id, data, scrollTo) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "https://api.audioblast.org/analysis/"+table+"/columns/?output=nakedJSON", true);
  xhr.extraInfo = [element, table, source, id, data, scrollTo];
  xhr.onload = function (e) {
    if (xhr.readyState === 4) {
      if (xhr.status === 200) {
        var table = this.extraInfo[1];
        var element = this.extraInfo[0];
        var source = this.extraInfo[2];
        var id = this.extraInfo[3];
        var data = this.extraInfo[4];
        var scrollTo = this.extraInfo[5];
        var cols = JSON.parse(this.responseText);
        var ajaxURL = 'https://api.audioblast.org/analysis/'+table+'/?source='+source+'&id='+id;
        var settings = {
          index:"startTime",
          height:"100%",
          ajaxURL:ajaxURL,
          progressiveLoad:"scroll",
          paginationSize:50,
          dataSendParams:{
            "size":"page_size",
          },
          columns:parseColumns(cols),
          dataLoaded: function(){
            if (scrollTo != null) {
              this.scrollToRow(scrollTo);
            }
          }
        };
        if (this.data == null ) {
          settings.ajaxProgressiveLoad = "load";
          settings.ajaxURL = ajaxURL;
        } else {
          settings.data = this.data;
        }

        var table = new Tabulator(element, settings);
      } else {
        console.error(xhr.statusText);
      }
    }
  };
  xhr.onerror = function (e) {
    console.error(xhr.statusText);
  };
  xhr.send(null);
}

var parseColumns = function(cols) {
  for (var i = 0; i < cols.length; i++) {
    if (cols[i]["headerFilter"] == "range") {
      cols[i]["headerFilter"] = minMaxFilterEditor;
      cols[i]["headerFilterFunc"] = minMaxFilterFunction;
    }
  }
  return(cols);
}

var minMaxFilterEditor = function(cell, onRendered, success, cancel, editorParams){

    var end;

    var container = document.createElement("span");

    //create and style inputs
    var start = document.createElement("input");
    start.setAttribute("type", "number");
    start.setAttribute("placeholder", "Min");
    start.setAttribute("min", 0);
    start.setAttribute("max", 100);
    start.style.padding = "4px";
    start.style.width = "50%";
    start.style.boxSizing = "border-box";

    start.value = cell.getValue();

    function buildValues(){
        success({
            start:start.value,
            end:end.value,
        });
    }

    function keypress(e){
        if(e.keyCode == 13){
            buildValues();
        }

        if(e.keyCode == 27){
            cancel();
        }
    }

    end = start.cloneNode();
    end.setAttribute("placeholder", "Max");

    start.addEventListener("change", buildValues);
    start.addEventListener("blur", buildValues);
    start.addEventListener("keydown", keypress);

    end.addEventListener("change", buildValues);
    end.addEventListener("blur", buildValues);
    end.addEventListener("keydown", keypress);


    container.appendChild(start);
    container.appendChild(end);

    return container;
 }

//custom max min filter function
function minMaxFilterFunction(headerValue, rowValue, rowData, filterParams){
    //headerValue - the value of the header filter element
    //rowValue - the value of the column in this row
    //rowData - the data for the row being filtered
    //filterParams - params object passed to the headerFilterFuncParams property

        if(rowValue){
            if(rowValue == null) {
              return false;
            }
            if(headerValue.start != ""){
                if(headerValue.end != ""){
                    return rowValue >= headerValue.start && rowValue <= headerValue.end;
                }else{
                    return rowValue >= headerValue.start;
                }
            }else{
                if(headerValue.end != ""){
                    return rowValue <= headerValue.end;
                }
            }
        }

    return true; //must return a boolean, true if it passes the filter.
}
