// Hadoop/YARN Topology
CREATE (rm:Service {name: 'ResourceManager', tier: 'control-plane', owner_team: 'data-platform', namespace: 'hadoop'})
CREATE (nm1:Service {name: 'NodeManager-1', tier: 'worker', owner_team: 'data-platform', namespace: 'hadoop'})
CREATE (nm2:Service {name: 'NodeManager-2', tier: 'worker', owner_team: 'data-platform', namespace: 'hadoop'})
CREATE (am:Service {name: 'MRAppMaster', tier: 'app', owner_team: 'data-eng', namespace: 'hadoop'})

CREATE (rm)-[:DEPENDS_ON {protocol: 'rpc'}]->(nm1)
CREATE (rm)-[:DEPENDS_ON {protocol: 'rpc'}]->(nm2)
CREATE (am)-[:DEPENDS_ON {protocol: 'rpc'}]->(rm)

// HDFS Topology
CREATE (nn:Service {name: 'NameNode', tier: 'control-plane', owner_team: 'data-platform', namespace: 'hdfs'})
CREATE (dn1:Service {name: 'DataNode-1', tier: 'worker', owner_team: 'data-platform', namespace: 'hdfs'})
CREATE (dn2:Service {name: 'DataNode-2', tier: 'worker', owner_team: 'data-platform', namespace: 'hdfs'})

CREATE (nn)-[:DEPENDS_ON {protocol: 'rpc'}]->(dn1)
CREATE (nn)-[:DEPENDS_ON {protocol: 'rpc'}]->(dn2)
CREATE (dn1)-[:DEPENDS_ON {protocol: 'rpc'}]->(nn)
CREATE (dn2)-[:DEPENDS_ON {protocol: 'rpc'}]->(nn)

// OpenStack Topology
CREATE (napi:Service {name: 'nova-api', tier: 'api', owner_team: 'compute', namespace: 'openstack'})
CREATE (nsched:Service {name: 'nova-scheduler', tier: 'control-plane', owner_team: 'compute', namespace: 'openstack'})
CREATE (ncomp:Service {name: 'nova-compute', tier: 'worker', owner_team: 'compute', namespace: 'openstack'})

CREATE (napi)-[:DEPENDS_ON {protocol: 'rpc'}]->(nsched)
CREATE (nsched)-[:DEPENDS_ON {protocol: 'rpc'}]->(ncomp)

// Runbooks
CREATE (rb1:Runbook {title: 'Disk Full Runbook', url: 'docs/runbooks/disk-full.md'})
CREATE (rb1)-[:HANDLES]->(:FaultType {name: 'disk'})

CREATE (rb2:Runbook {title: 'Node Down Runbook', url: 'docs/runbooks/node-down.md'})
CREATE (rb2)-[:HANDLES]->(:FaultType {name: 'host-down'})

CREATE (rb3:Runbook {title: 'Network Disconnection Runbook', url: 'docs/runbooks/network-loss.md'})
CREATE (rb3)-[:HANDLES]->(:FaultType {name: 'network-loss'})
